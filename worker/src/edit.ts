import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import {
  editedClipKey,
  MUSIC_PREFIX,
  type ClipEditData,
  type ClipEditOptions,
  type JobParams,
  type JobResult,
} from "@clipflow/shared";
import { reportProgress, schema, type Job, type JobStage } from "@clipflow/shared/db";
import { chooseVerticalCrop, detectContentBox, probe, renderVerticalClip, type ProbeResult } from "./ffmpeg.js";
import { JobError, JobStopped, type PipelineDeps } from "./pipeline.js";
import { buildKaraokeAss, SUBTITLE_FONTS_DIR } from "./subtitles.js";
import { measureLoudness, pickActionMoments, renderViralClip } from "./viral.js";

const { clips, processingJobs, subtitles, usage, videos } = schema;

/** Progreso de un trabajo de edición. */
const STAGES: Partial<Record<JobStage, [number, number]>> = {
  preparing: [0, 8],
  rendering_clips: [8, 96],
  finalizing: [96, 99],
};

const MUSIC_EXTENSIONS = /\.(mp3|m4a|aac|wav|ogg|opus)$/i;

export const NO_SOURCE_MESSAGE =
  "Este clip se creó antes del editor y su video original ya no está guardado. Vuelve a crear los clips del video para editarlos.";

/**
 * Trabajo «editar clips» (por ahora solo el modo viral): toma cada clip limpio (sin subtítulos), le pone
 * subtítulos karaoke, efectos en los momentos fuertes y música, y guarda la versión editada aparte (el
 * clip original no cambia).
 */
export async function processEditJob(job: Job, deps: PipelineDeps): Promise<JobResult> {
  const params = job.params as JobParams;
  const edit: ClipEditOptions = params.edit ?? { mode: "viral", music: true };
  const clipIds = params.clipIds ?? [];
  if (clipIds.length === 0) throw new JobError("nothing_to_edit", "No hay clips para editar.", false);

  const startedAt = Date.now();
  const controller = new AbortController();
  let current: { stage: JobStage; progress: number } = { stage: "preparing", progress: 0 };
  let stopped: JobStopped | undefined;
  let lastReport = 0;
  const beat = async () => {
    const decision = await reportProgress(deps.db, job.id, deps.workerId, current);
    if (decision !== "continue" && !stopped) {
      stopped = new JobStopped(decision);
      controller.abort();
    }
  };
  const heartbeat = setInterval(() => void beat().catch(() => undefined), 30_000);
  const progress = async (stage: JobStage, fraction: number, force = false) => {
    const [from, to] = STAGES[stage] ?? [0, 99];
    current = { stage, progress: from + (to - from) * Math.min(1, Math.max(0, fraction)) };
    if (force || Date.now() - lastReport > 3000) {
      lastReport = Date.now();
      await beat();
    }
    if (stopped) throw stopped;
  };

  const dir = path.join(deps.workDir, job.id);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  try {
    await progress("preparing", 0, true);
    const rows = await deps.db.select().from(clips).where(and(eq(clips.userId, job.userId), eq(clips.videoId, job.videoId)));
    const targets = clipIds.map((id) => rows.find((r) => r.id === id)).filter((r): r is (typeof rows)[number] => Boolean(r));
    if (targets.length === 0) throw new JobError("nothing_to_edit", "Los clips ya no existen.", false);
    const [video] = await deps.db.select().from(videos).where(eq(videos.id, job.videoId));
    if (!video) throw new JobError("video_not_found", "El video ya no existe.", false);

    const music = edit.music ? await pickMusicLibrary(deps) : [];
    let original: { file: string; info: ProbeResult } | null = null;
    let edited = 0;
    let skipped = 0;
    const done = new Array<number>(targets.length).fill(0);
    const report = (force = false) =>
      progress("rendering_clips", done.reduce((a, b) => a + b, 0) / targets.length, force).catch((err: unknown) => {
        if (err instanceof JobStopped) throw err;
      });

    for (const [index, clip] of targets.entries()) {
      const duration = clip.endSeconds - clip.startSeconds;
      const source = path.join(dir, `source-${index}.mp4`);

      // 1. El clip sin subtítulos: el guardado al crearlo o, en clips anteriores al editor, rehecho
      // del video original (solo si sigue guardado: archivos subidos).
      if (clip.cleanS3Key) {
        await deps.storage.download(clip.cleanS3Key, source, undefined, controller.signal);
      } else {
        const probeData = video.probe as { clipflowOriginalDeleted?: boolean; clipflowAnalysisCopy?: boolean } | null;
        if (video.sourceUrl || probeData?.clipflowOriginalDeleted || probeData?.clipflowAnalysisCopy) {
          skipped++;
          done[index] = 1;
          deps.log.warn({ jobId: job.id, clip: clip.id }, "clip sin copia limpia ni video original: no se edita");
          continue;
        }
        if (!original) {
          const file = path.join(dir, `original${path.extname(video.s3Key) || ".mp4"}`);
          await deps.storage.download(video.s3Key, file, undefined, controller.signal);
          original = { file, info: await probe(deps.tools, file) };
        }
        // Si el video se procesó por tramo, los tiempos del clip cuentan desde el inicio del tramo.
        const offset = await rangeOffset(deps, clip.jobId);
        const segment = { startSeconds: clip.startSeconds + offset, durationSeconds: duration };
        const box = await detectContentBox(deps.tools, original.file, original.info, controller.signal);
        const crop = await chooseVerticalCrop(deps.tools, original.file, original.info, box, segment, controller.signal, {
          faces: deps.faceTracking ?? false,
        });
        await renderVerticalClip(deps.tools, original.file, source, segment, {
          signal: controller.signal,
          crop,
          onProgress: (sec) => {
            done[index] = Math.min(0.4, (sec / duration) * 0.4);
            void report();
          },
        });
      }
      const info = await probe(deps.tools, source);

      // 2. Palabras y sonidos del clip.
      const data = await loadEditData(deps, clip.id, job.userId, clip.editDataS3Key, dir, index);

      // 3. Momentos fuertes: picos de volumen del clip y sonidos detectados.
      const loudness = info.hasAudio ? await measureLoudness(deps.tools, source, dir, controller.signal) : [];
      const moments = pickActionMoments(info.durationSeconds, loudness, data?.sounds);

      // 4. Subtítulos karaoke y música.
      let subtitlesFile: { file: string; fontsDir: string } | undefined;
      const ass = data?.words.length ? buildKaraokeAss(data.words, info.durationSeconds) : null;
      if (ass) {
        const file = path.join(dir, `karaoke-${index}.ass`);
        await writeFile(file, ass);
        subtitlesFile = { file, fontsDir: SUBTITLE_FONTS_DIR };
      }
      let musicFile: string | undefined;
      if (music.length) {
        const key = music[hash(clip.id) % music.length]!;
        musicFile = path.join(dir, `music-${index}${path.extname(key)}`);
        await deps.storage.download(key, musicFile, undefined, controller.signal);
      }

      // 5. El video viral.
      const output = path.join(dir, `edited-${index}.mp4`);
      const start = done[index]!;
      await renderViralClip(deps.tools, source, output, {
        durationSeconds: info.durationSeconds,
        hasAudio: info.hasAudio,
        moments,
        subtitles: subtitlesFile,
        music: musicFile,
        signal: controller.signal,
        onProgress: (sec) => {
          done[index] = start + (1 - start) * Math.min(0.95, sec / info.durationSeconds);
          void report();
        },
      });
      if (stopped) throw stopped;
      const key = editedClipKey(job.userId, job.id, clip.id);
      await deps.storage.upload(output, key, "video/mp4");
      await deps.db
        .update(clips)
        .set({
          editedS3Key: key,
          edit: { ...edit, music: Boolean(musicFile), at: new Date().toISOString(), jobId: job.id, moments: moments.length },
        })
        .where(and(eq(clips.id, clip.id), eq(clips.userId, job.userId)));
      for (const f of [source, output, musicFile]) if (f) await rm(f, { force: true });
      edited++;
      done[index] = 1;
      await report(true);
      deps.log.info({ jobId: job.id, clip: clip.id, moments: moments.length, words: data?.words.length ?? 0, music: Boolean(musicFile) }, "clip editado");
    }

    if (edited === 0) throw new JobError("edit_source_missing", NO_SOURCE_MESSAGE, false);
    await progress("finalizing", 0, true);
    const processingSeconds = (Date.now() - startedAt) / 1000;
    const computeUsd = Math.round(((processingSeconds / 3600) * deps.costPerHourUsd) * 1_000_000) / 1_000_000;
    await deps.db.insert(usage).values({
      userId: job.userId,
      jobId: job.id,
      videoId: job.videoId,
      metric: "processing_seconds",
      quantity: processingSeconds,
      estimatedCostUsd: computeUsd,
      details: { workerId: deps.workerId, attempt: job.attempts, edit: edit.mode, clips: edited },
    });
    return {
      clipCount: edited,
      ai: "disabled",
      aiReason: skipped ? `${skipped} clip(s) sin video original` : "Edición",
      costs: { transcriptionUsd: 0, textUsd: 0, visionUsd: 0, computeUsd, totalUsd: computeUsd },
    };
  } catch (err) {
    if (stopped) throw stopped;
    throw err;
  } finally {
    clearInterval(heartbeat);
    await rm(dir, { recursive: true, force: true });
  }
}

/** Pistas de música cargadas en la carpeta `music/` del bucket (vacío si no hay o no se puede leer). */
async function pickMusicLibrary(deps: PipelineDeps): Promise<string[]> {
  if (!deps.storage.list) return [];
  try {
    return (await deps.storage.list(MUSIC_PREFIX)).filter((k) => MUSIC_EXTENSIONS.test(k)).sort();
  } catch (err) {
    deps.log.warn({ error: (err as Error).name }, "no se pudo leer la carpeta de música");
    return [];
  }
}

/** Mismo clip, misma pista (y clips distintos, pistas variadas). */
function hash(text: string): number {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

/** Desde qué segundo del archivo subido empezó el tramo procesado (0 si fue el video completo). */
async function rangeOffset(deps: PipelineDeps, analyzeJobId: string | null): Promise<number> {
  if (!analyzeJobId) return 0;
  const [row] = await deps.db.select({ params: processingJobs.params }).from(processingJobs).where(eq(processingJobs.id, analyzeJobId));
  return (row?.params as JobParams | undefined)?.rangeStartSeconds ?? 0;
}

/**
 * Palabras (con tiempo) y sonidos del clip: los guardados al crearlo o, en clips anteriores al editor,
 * sus subtítulos (WebVTT) con las palabras repartidas dentro de cada frase.
 */
async function loadEditData(
  deps: PipelineDeps,
  clipId: string,
  userId: string,
  dataKey: string | null,
  dir: string,
  index: number,
): Promise<ClipEditData | null> {
  const file = path.join(dir, `edit-${index}.json`);
  try {
    if (dataKey) {
      await deps.storage.download(dataKey, file);
      return JSON.parse(await readFile(file, "utf8")) as ClipEditData;
    }
    const [vtt] = await deps.db
      .select({ key: subtitles.s3Key })
      .from(subtitles)
      .where(and(eq(subtitles.clipId, clipId), eq(subtitles.userId, userId), eq(subtitles.format, "vtt")));
    if (!vtt) return null;
    await deps.storage.download(vtt.key, file);
    return { version: 1, durationSeconds: 0, words: wordsFromVtt(await readFile(file, "utf8")), sounds: [] };
  } catch (err) {
    deps.log.warn({ clip: clipId, error: (err as Error).name }, "no se pudieron leer las palabras del clip");
    return null;
  } finally {
    await rm(file, { force: true });
  }
}

/** Palabras de un WebVTT: cada frase repartida según el largo de cada palabra. */
export function wordsFromVtt(text: string): ClipEditData["words"] {
  const words: ClipEditData["words"] = [];
  const time = (t: string) => {
    const parts = t.trim().split(":").map(Number);
    return parts.reduce((acc, p) => acc * 60 + p, 0);
  };
  for (const block of text.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const cue = lines.findIndex((l) => l.includes("-->"));
    if (cue < 0) continue;
    const [a, b] = lines[cue]!.split("-->");
    const start = time(a!);
    const end = time(b!.trim().split(/\s+/)[0]!);
    const tokens = lines.slice(cue + 1).join(" ").replace(/<[^>]+>/g, "").split(/\s+/).filter(Boolean);
    if (!tokens.length || !(end > start)) continue;
    const total = tokens.reduce((n, t) => n + t.length + 1, 0);
    let t = start;
    for (const token of tokens) {
      const d = ((end - start) * (token.length + 1)) / total;
      words.push({ startSeconds: t, endSeconds: t + d, text: token });
      t += d;
    }
  }
  return words;
}
