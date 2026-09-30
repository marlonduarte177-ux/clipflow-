import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { writeFile } from "node:fs/promises";
import {
  bestFrameLabel,
  segmentsForRange,
  selectMoments,
  snapToSentences,
  speechSignalFromHighlights,
  toSrt,
  toVtt,
  visionSignalFromFrames,
  type AIAnalysisProvider,
  type FrameScore,
  type AIUsage,
  type JobResult,
  type ProductConfig,
  type SignalSeries,
  type TranscriptSegment,
} from "@clipflow/shared";
import { reportProgress, schema, type Database, type Job, type JobStage } from "@clipflow/shared/db";
import {
  analyzeSignals,
  buildFrameSheets,
  chooseVerticalCrop,
  detectContentBox,
  extractAudioChunks,
  FfmpegError,
  probe,
  renderThumbnail,
  renderVerticalClip,
  type FfmpegTools,
} from "./ffmpeg.js";
import type { WorkerStorage } from "./storage.js";

const { clips, subtitles, usage, videos } = schema;

/** Error con mensaje para el usuario y si vale la pena reintentar. */
export class JobError extends Error {
  constructor(
    readonly code: string,
    readonly userMessage: string,
    readonly retryable: boolean,
  ) {
    super(userMessage);
    this.name = "JobError";
  }
}

/** El usuario canceló, u otro worker tomó el trabajo: hay que detenerse. */
export class JobStopped extends Error {
  constructor(readonly reason: "cancel" | "lost") {
    super(reason === "cancel" ? "Cancelado por el usuario" : "El trabajo lo tomó otro worker");
    this.name = "JobStopped";
  }
}

export interface PipelineDeps {
  db: Database;
  storage: WorkerStorage;
  tools: FfmpegTools;
  product: ProductConfig;
  workDir: string;
  workerId: string;
  /** Costo estimado por hora del worker (Fargate), para registrar rentabilidad. */
  costPerHourUsd: number;
  /** Proveedor de IA (OpenAI). null = no configurado: se procesa solo con FFmpeg. */
  ai: AIAnalysisProvider | null;
  /** Por qué no hay IA (para mostrarlo al usuario). */
  aiDisabledReason?: string;
  /** Máximo de minutos de audio que se envían a la IA por video (control de costos). */
  aiMaxAudioMinutes: number;
  /** Clips que se generan a la vez (por defecto 2). */
  renderConcurrency?: number;
  /** Análisis de imágenes con IA (experimental, tiene costo por imagen). */
  vision?: { enabled: boolean; intervalSeconds: number; maxFrames: number };
  log: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
}

/** Rango de progreso real de cada etapa. */
const STAGES: Record<JobStage, [number, number]> = {
  preparing: [0, 10],
  analyzing: [10, 45],
  detecting_moments: [45, 50],
  rendering_clips: [50, 95],
  finalizing: [95, 99],
};

/**
 * Procesa un video: descarga → valida con ffprobe → calcula señales → elige momentos →
 * genera clips 9:16 y miniaturas → sube a S3 → registra clips y consumo.
 * Es seguro repetirlo: las rutas de salida son fijas por trabajo y los clips previos se reemplazan.
 */
export async function processAnalyzeJob(job: Job, deps: PipelineDeps): Promise<JobResult> {
  const startedAt = Date.now();
  const dir = path.join(deps.workDir, job.id);
  const controller = new AbortController();
  let lastReport = 0;

  // Latido cada 30 s aunque el progreso no cambie (p. ej. un FFmpeg largo).
  let current: { stage: JobStage; progress: number } = { stage: "preparing", progress: 0 };
  let stopped: JobStopped | undefined;
  const beat = async () => {
    const decision = await reportProgress(deps.db, job.id, deps.workerId, current);
    if (decision !== "continue" && !stopped) {
      stopped = new JobStopped(decision);
      controller.abort();
    }
  };
  const heartbeat = setInterval(() => void beat().catch(() => undefined), 30_000);

  const progress = async (stage: JobStage, fraction: number, force = false) => {
    const [from, to] = STAGES[stage];
    current = { stage, progress: from + (to - from) * Math.min(1, Math.max(0, fraction)) };
    if (force || Date.now() - lastReport > 3000) {
      lastReport = Date.now();
      await beat();
    }
    if (stopped) throw stopped;
  };
  const tick = (stage: JobStage, total: number) => (value: number) => void progress(stage, value / total).catch(() => undefined);
  const check = () => {
    if (stopped) throw stopped;
  };

  try {
    await mkdir(dir, { recursive: true });
    const [video] = await deps.db
      .select()
      .from(videos)
      .where(and(eq(videos.id, job.videoId), eq(videos.userId, job.userId)));
    if (!video) throw new JobError("video_not_found", "El video ya no existe.", false);

    // 1. Preparar: descargar y comprobar el contenido real.
    await progress("preparing", 0, true);
    const input = path.join(dir, `input${path.extname(video.s3Key)}`);
    await deps.storage.download(video.s3Key, input, tick("preparing", video.sizeBytes * 1.25), controller.signal);
    check();

    let info;
    try {
      info = await probe(deps.tools, input);
    } catch {
      await rejectVideo(deps.db, video.id, "El archivo no es un video válido o está dañado.");
      throw new JobError("invalid_video", "El archivo no es un video válido o está dañado.", false);
    }
    if (info.durationSeconds > deps.product.upload.maxDurationSeconds) {
      const msg = "El video supera la duración máxima permitida.";
      await rejectVideo(deps.db, video.id, msg);
      throw new JobError("video_too_long", msg, false);
    }
    await deps.db
      .update(videos)
      .set({ status: "ready", durationSeconds: info.durationSeconds, width: info.width, height: info.height, probe: info.raw })
      .where(eq(videos.id, video.id));
    // Franjas negras "quemadas" en el video (p. ej. horizontal subido como vertical): se quitan.
    const contentBox = await detectContentBox(deps.tools, input, info, controller.signal);
    if (contentBox) deps.log.info({ jobId: job.id, contentBox }, "franjas negras detectadas");
    await progress("preparing", 1, true);

    // 2. Analizar EN PARALELO (ahorra minutos):
    //    a) señales por segundo con FFmpeg (volumen, picos de acción, movimiento);
    //    b) IA de audio: transcripción + momentos por contenido;
    //    c) IA de imágenes (experimental): lo que se ve en pantalla.
    //    Si la IA falla, el video se procesa igual y el resultado lo indica.
    const parts = { signals: 0, ai: 0, vision: 0 };
    const report = (part: keyof typeof parts) => (fraction: number) => {
      parts[part] = Math.min(1, Math.max(0, fraction));
      return progress("analyzing", parts.signals * 0.5 + parts.ai * 0.25 + parts.vision * 0.25).catch(() => undefined);
    };
    const [raw, ai, vision] = await Promise.all([
      analyzeSignals(deps.tools, input, info, dir, {
        signal: controller.signal,
        onProgress: (sec) => void report("signals")(sec / info.durationSeconds),
      }),
      runAI(deps, info, input, dir, controller.signal, async (f) => void (await report("ai")(f))),
      runVision(deps, info, input, dir, contentBox, controller.signal, async (f) => void (await report("vision")(f))),
    ]);
    check();
    const signals: SignalSeries = {
      visual: raw.visual,
      ...(raw.audio ? { audio: raw.audio } : {}),
      ...(raw.action ? { action: raw.action } : {}),
    };
    if (ai.highlights) signals.speech = speechSignalFromHighlights(ai.highlights, info.durationSeconds);
    if (vision.frames.length) {
      signals.vision = visionSignalFromFrames(vision.frames, info.durationSeconds, vision.intervalSeconds);
    }
    await progress("analyzing", 1, true);

    // 3. Elegir momentos con el score configurable (sin forzar una cantidad).
    const params = job.params as { clipDurationSeconds?: number };
    const clipDuration = deps.product.clipDurationsSeconds.includes(params.clipDurationSeconds ?? -1)
      ? params.clipDurationSeconds!
      : deps.product.defaultClipDurationSeconds;
    const moments = selectMoments({
      durationSeconds: info.durationSeconds,
      signals,
      weights: deps.product.scoreWeights,
      clipDurationSeconds: clipDuration,
      minScore: deps.product.minClipScore,
      maxClips: deps.product.maxClipsPerVideo,
    });
    // Con transcripción: el clip empieza y termina en frases completas.
    const finalMoments = ai.segments.length
      ? moments.map((m) => snapToSentences(m, ai.segments, { videoDurationSeconds: info.durationSeconds }))
      : moments;
    let titles: (string | null)[] = finalMoments.map(() => null);
    if (deps.ai && ai.segments.length && finalMoments.length) {
      try {
        const suggestion = await deps.ai.generateClipSuggestions(ai.segments, finalMoments);
        titles = suggestion.titles;
        addUsage(ai.usage, suggestion.usage);
      } catch (err) {
        deps.log.warn({ jobId: job.id, error: (err as Error).message }, "no se pudieron generar títulos");
      }
    }
    // Sin título de la transcripción (p. ej. gameplay sin voz): lo que se ve en el mejor fotograma.
    titles = titles.map((t, i) => t ?? bestFrameLabel(vision.frames, finalMoments[i]!.startSeconds, finalMoments[i]!.endSeconds));
    deps.log.info(
      { jobId: job.id, moments: finalMoments.length, clipDuration, ai: ai.status, vision: vision.status },
      "momentos elegidos",
    );
    await progress("detecting_moments", 1, true);

    // 4. Generar clips verticales y miniaturas; subir a S3 con rutas fijas por trabajo.
    const outputs: {
      moment: (typeof moments)[number];
      key: string;
      thumbKey: string;
      title: string | null;
      subtitleKeys: { srt: string; vtt: string } | null;
    }[] = [];
    // Progreso real de cada clip (se generan de a varios a la vez).
    const clipProgress = new Array<number>(finalMoments.length).fill(0);
    const reportClips = (force = false) =>
      progress(
        "rendering_clips",
        clipProgress.reduce((a, b) => a + b, 0) / Math.max(1, finalMoments.length),
        force,
      ).catch(() => undefined);

    const renderOne = async (index: number) => {
      const moment = finalMoments[index]!;
      const duration = moment.endSeconds - moment.startSeconds;
      const clipFile = path.join(dir, `clip-${index}.mp4`);
      const thumbFile = path.join(dir, `thumb-${index}.jpg`);
      const segment = { startSeconds: moment.startSeconds, durationSeconds: duration };
      // Encuadre por clip: sin franjas negras y centrado donde está la acción.
      const crop = await chooseVerticalCrop(deps.tools, input, info, contentBox, segment, controller.signal);
      await renderVerticalClip(deps.tools, input, clipFile, segment, {
        signal: controller.signal,
        crop,
        onProgress: (sec) => {
          clipProgress[index] = Math.min(0.95, sec / duration);
          void reportClips();
        },
      });
      await renderThumbnail(deps.tools, input, thumbFile, moment.startSeconds + duration / 2, controller.signal, crop);
      check();
      const key = `clips/${job.userId}/${job.id}/${index}.mp4`;
      const thumbKey = `thumbnails/${job.userId}/${job.id}/${index}.jpg`;
      await deps.storage.upload(clipFile, key, "video/mp4");
      await deps.storage.upload(thumbFile, thumbKey, "image/jpeg");

      // Subtítulos del clip (tiempos relativos al clip).
      let subtitleKeys: { srt: string; vtt: string } | null = null;
      const clipSegments = segmentsForRange(ai.segments, moment.startSeconds, moment.endSeconds);
      if (clipSegments.length) {
        subtitleKeys = {
          srt: `subtitles/${job.userId}/${job.id}/${index}.srt`,
          vtt: `subtitles/${job.userId}/${job.id}/${index}.vtt`,
        };
        const srtFile = path.join(dir, `sub-${index}.srt`);
        const vttFile = path.join(dir, `sub-${index}.vtt`);
        await writeFile(srtFile, toSrt(clipSegments));
        await writeFile(vttFile, toVtt(clipSegments));
        await deps.storage.upload(srtFile, subtitleKeys.srt, "application/x-subrip");
        await deps.storage.upload(vttFile, subtitleKeys.vtt, "text/vtt");
      }
      outputs[index] = { moment, key, thumbKey, title: titles[index] ?? null, subtitleKeys };
      clipProgress[index] = 1;
      await reportClips(true);
    };

    // Varios clips a la vez (cada FFmpeg usa varios núcleos); el orden final se mantiene.
    let nextClip = 0;
    const clipWorker = async () => {
      while (nextClip < finalMoments.length) await renderOne(nextClip++);
    };
    await Promise.all(Array.from({ length: Math.min(deps.renderConcurrency ?? 2, finalMoments.length) }, clipWorker));

    // 5. Registrar resultados y consumo (en una transacción).
    await progress("finalizing", 0, true);
    const processingSeconds = (Date.now() - startedAt) / 1000;
    const computeCostUsd = (processingSeconds / 3600) * deps.costPerHourUsd;
    const textCostUsd = (ai.usage.estimatedCostUsd ?? 0) - ai.transcribeCostUsd;
    const visionCostUsd = vision.usage.estimatedCostUsd ?? 0;
    await deps.db.transaction(async (tx) => {
      await tx.delete(clips).where(eq(clips.jobId, job.id)); // reintento: reemplaza, no duplica (y sus subtítulos)
      if (outputs.length > 0) {
        const inserted = await tx
          .insert(clips)
          .values(
            outputs.map(({ moment, key, thumbKey, title }) => ({
              userId: job.userId,
              videoId: job.videoId,
              jobId: job.id,
              title,
              startSeconds: moment.startSeconds,
              endSeconds: moment.endSeconds,
              aspectRatio: "9:16" as const,
              score: moment.score,
              scoreBreakdown: moment.breakdown,
              s3Key: key,
              thumbnailS3Key: thumbKey,
            })),
          )
          .returning({ id: clips.id });
        const subtitleRows = outputs.flatMap((o, i) =>
          o.subtitleKeys
            ? (["srt", "vtt"] as const).map((format) => ({
                userId: job.userId,
                videoId: job.videoId,
                clipId: inserted[i]!.id,
                format,
                language: ai.language,
                s3Key: o.subtitleKeys![format],
              }))
            : [],
        );
        if (subtitleRows.length) await tx.insert(subtitles).values(subtitleRows);
      }
      const base = { userId: job.userId, jobId: job.id, videoId: job.videoId };
      await tx.insert(usage).values([
        { ...base, metric: "video_seconds_processed", quantity: info.durationSeconds },
        {
          ...base,
          metric: "processing_seconds",
          quantity: processingSeconds,
          estimatedCostUsd: computeCostUsd,
          details: { workerId: deps.workerId, attempt: job.attempts },
        },
        { ...base, metric: "clips_generated", quantity: outputs.length },
        ...(ai.usage.audioSeconds
          ? [
              {
                ...base,
                metric: "ai_audio_seconds" as const,
                quantity: ai.usage.audioSeconds,
                estimatedCostUsd: ai.transcribeCostUsd,
                details: { provider: deps.ai?.name },
              },
            ]
          : []),
        ...(ai.usage.inputTokens
          ? [
              {
                ...base,
                metric: "ai_input_tokens" as const,
                quantity: ai.usage.inputTokens,
                estimatedCostUsd: textCostUsd,
                details: { provider: deps.ai?.name, kind: "text" },
              },
              { ...base, metric: "ai_output_tokens" as const, quantity: ai.usage.outputTokens ?? 0, details: { kind: "text" } },
            ]
          : []),
        ...(vision.usage.inputTokens
          ? [
              {
                ...base,
                metric: "ai_input_tokens" as const,
                quantity: vision.usage.inputTokens,
                estimatedCostUsd: visionCostUsd,
                details: { provider: deps.ai?.name, kind: "vision", frames: vision.frames.length },
              },
              {
                ...base,
                metric: "ai_output_tokens" as const,
                quantity: vision.usage.outputTokens ?? 0,
                details: { kind: "vision" },
              },
            ]
          : []),
      ]);
    });
    const usd = (n: number) => Math.round(n * 1_000_000) / 1_000_000;
    return {
      clipCount: outputs.length,
      ai: ai.status,
      ...(ai.reason ? { aiReason: ai.reason } : {}),
      language: ai.language,
      vision: vision.status,
      visionFrames: vision.frames.length,
      costs: {
        transcriptionUsd: usd(ai.transcribeCostUsd),
        textUsd: usd(textCostUsd),
        visionUsd: usd(visionCostUsd),
        computeUsd: usd(computeCostUsd),
        totalUsd: usd(ai.transcribeCostUsd + textCostUsd + visionCostUsd + computeCostUsd),
      },
    };
  } catch (err) {
    if (stopped) throw stopped;
    if (err instanceof JobError || err instanceof JobStopped) throw err;
    if (err instanceof FfmpegError) {
      deps.log.warn({ jobId: job.id, stderr: err.stderrTail }, "FFmpeg falló");
      throw new JobError("ffmpeg_failed", "No pudimos procesar este video. Lo intentaremos de nuevo.", true);
    }
    deps.log.warn({ jobId: job.id, error: (err as Error).message }, "error inesperado");
    throw new JobError("unexpected", "Ocurrió un error temporal al procesar el video.", true);
  } finally {
    clearInterval(heartbeat);
    await rm(dir, { recursive: true, force: true });
  }
}

interface AIOutcome {
  status: JobResult["ai"];
  reason?: string;
  segments: TranscriptSegment[];
  highlights?: import("@clipflow/shared").ContentHighlight[];
  language: string | null;
  usage: AIUsage;
  transcribeCostUsd: number;
}

function addUsage(total: AIUsage, extra: AIUsage) {
  total.inputTokens = (total.inputTokens ?? 0) + (extra.inputTokens ?? 0);
  total.outputTokens = (total.outputTokens ?? 0) + (extra.outputTokens ?? 0);
  total.estimatedCostUsd = (total.estimatedCostUsd ?? 0) + (extra.estimatedCostUsd ?? 0);
}

/** Transcripción + análisis con IA. Nunca hace fallar el trabajo: si algo falla, lo informa. */
async function runAI(
  deps: PipelineDeps,
  info: { durationSeconds: number; hasAudio: boolean },
  input: string,
  dir: string,
  signal: AbortSignal,
  onProgress: (fraction: number) => Promise<void>,
): Promise<AIOutcome> {
  const empty = { segments: [], language: null, usage: {}, transcribeCostUsd: 0 };
  if (!deps.ai) return { ...empty, status: "disabled", reason: deps.aiDisabledReason ?? "IA no configurada" };
  if (!info.hasAudio) return { ...empty, status: "no_audio", reason: "El video no tiene audio" };
  try {
    const chunks = await extractAudioChunks(deps.tools, input, dir, {
      maxSeconds: Math.min(info.durationSeconds, deps.aiMaxAudioMinutes * 60),
      signal,
    });
    await onProgress(0.2);
    const transcript = await deps.ai.transcribe(chunks);
    await onProgress(0.7);

    // Sin habla real (p. ej. gameplay o música): no se inventan títulos ni subtítulos,
    // y los momentos se eligen por acción, sonido y movimiento.
    const analyzedSeconds = chunks.reduce((sum, c) => sum + c.durationSeconds, 0);
    const speechSeconds = transcript.segments.reduce((sum, s) => sum + (s.endSeconds - s.startSeconds), 0);
    if (speechSeconds < Math.max(15, analyzedSeconds * 0.1)) {
      return {
        status: "no_speech",
        reason: "No se detectó habla (p. ej. gameplay o música); los clips se eligieron por acción, sonido y movimiento",
        segments: [],
        language: null,
        usage: { ...transcript.usage },
        transcribeCostUsd: transcript.usage.estimatedCostUsd ?? 0,
      };
    }
    const analysis = await deps.ai.analyze(transcript.segments, info.durationSeconds);
    const usage: AIUsage = { ...transcript.usage };
    const transcribeCostUsd = transcript.usage.estimatedCostUsd ?? 0;
    addUsage(usage, analysis.usage);
    return {
      status: "used",
      segments: transcript.segments,
      highlights: analysis.highlights,
      language: transcript.language,
      usage,
      transcribeCostUsd,
    };
  } catch (err) {
    if (signal.aborted) throw err;
    deps.log.warn({ error: (err as Error).message }, "IA no disponible; se continúa solo con FFmpeg");
    return { ...empty, status: "unavailable", reason: "El análisis con IA falló; los clips se eligieron solo por audio y escenas." };
  }
}

interface VisionOutcome {
  status: "used" | "disabled" | "unavailable";
  frames: FrameScore[];
  intervalSeconds: number;
  usage: AIUsage;
}

/** Análisis de imágenes (experimental). Nunca hace fallar el trabajo. */
async function runVision(
  deps: PipelineDeps,
  info: { durationSeconds: number; width: number; height: number; hasAudio: boolean; videoCodec: string; raw: unknown },
  input: string,
  dir: string,
  box: import("./ffmpeg.js").ContentBox | null,
  signal: AbortSignal,
  onProgress: (fraction: number) => Promise<void>,
): Promise<VisionOutcome> {
  const config = deps.vision;
  const off: VisionOutcome = { status: "disabled", frames: [], intervalSeconds: 0, usage: {} };
  if (!config?.enabled || !deps.ai?.analyzeFrames) return off;
  // Tope de fotogramas por video (control de costos): en videos largos se espacian más.
  const intervalSeconds = Math.max(config.intervalSeconds, info.durationSeconds / config.maxFrames);
  try {
    const sheets = await buildFrameSheets(deps.tools, input, dir, info, {
      intervalSeconds,
      box,
      signal,
      onProgress: (s) => void onProgress((s / info.durationSeconds) * 0.3).catch(() => undefined),
    });
    await onProgress(0.3);
    const result = await deps.ai.analyzeFrames(sheets);
    return { status: "used", frames: result.frames, intervalSeconds, usage: result.usage };
  } catch (err) {
    if (signal.aborted) throw err;
    deps.log.warn({ error: (err as Error).message }, "análisis de imágenes no disponible");
    return { ...off, status: "unavailable" };
  }
}

async function rejectVideo(db: Database, videoId: string, reason: string) {
  await db.update(videos).set({ status: "rejected", rejectionReason: reason }).where(eq(videos.id, videoId));
}
