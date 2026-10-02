import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { writeFile } from "node:fs/promises";
import {
  bestFrameLabel,
  fullTranscriptKey,
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
  type JobParams,
  type JobResult,
  type ProductConfig,
  type SignalSeries,
  type SubtitleStyle,
  type TranscriptSegment,
} from "@clipflow/shared";
import { reportProgress, schema, type Database, type Job, type JobStage } from "@clipflow/shared/db";
import {
  analyzeSignals,
  buildFrameSheets,
  chooseVerticalCrop,
  cropAt,
  detectContentBox,
  extractAudioChunks,
  FfmpegError,
  makePhoneCompatible,
  probe,
  renderThumbnail,
  renderVerticalClip,
  type FfmpegTools,
  type ProbeResult,
} from "./ffmpeg.js";
import type { WorkerStorage } from "./storage.js";
import { AIProviderError } from "./ai/openai.js";
import { buildAss, SUBTITLE_FONTS_DIR } from "./subtitles.js";
import { DownloadError, downloadFromUrl } from "./download.js";

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
  /** Encuadre que sigue caras (a quien habla, o al grupo). */
  faceTracking?: boolean;
  /** yt-dlp, para importar videos de TikTok, Instagram, Facebook y Kick. */
  ytDlpPath?: string;
  /** Proxy residencial para plataformas que bloquean a AWS (null = sin proxy). */
  downloadProxyUrl?: string | null;
  /** Sin proxy: por qué ("mal escrito", "sin configurar"). */
  downloadProxyProblem?: string | null;
  /** Descarga de enlaces (se reemplaza en tests). */
  download?: typeof downloadFromUrl;
  /** Análisis de imágenes con IA (experimental, tiene costo por imagen). */
  vision?: {
    enabled: boolean;
    intervalSeconds: number;
    maxFrames: number;
    /** Segundos máximos para empezar a enviar hojas (por defecto 180). */
    budgetSeconds?: number;
  };
  log: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
}

/** Rango de progreso real de cada etapa. */
const STAGES: Record<JobStage, [number, number]> = {
  downloading: [0, 0],
  preparing: [0, 10],
  analyzing: [10, 45],
  detecting_moments: [45, 50],
  rendering_clips: [50, 95],
  finalizing: [95, 99],
};
/** Videos importados por enlace: primero se descargan (el resto se corre un poco). */
const IMPORT_STAGES: Record<JobStage, [number, number]> = {
  downloading: [0, 20],
  preparing: [20, 26],
  analyzing: [26, 55],
  detecting_moments: [55, 58],
  rendering_clips: [58, 95],
  finalizing: [95, 99],
};

/** "Solo descargar": bajar el video y dejarlo listo para el celular (puede requerir convertirlo). */
const DOWNLOAD_ONLY_STAGES: Record<JobStage, [number, number]> = {
  downloading: [0, 60],
  preparing: [60, 99],
  analyzing: [99, 99],
  detecting_moments: [99, 99],
  rendering_clips: [99, 99],
  finalizing: [99, 99],
};

const MIME_BY_EXTENSION: Record<string, string> = { ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska" };

/** Título de la plataforma como nombre del archivo (sin caracteres de control). */
/**
 * Código técnico corto del error (p. ej. "AccessDenied" de S3 o "ENOSPC" de disco): ayuda a
 * diagnosticar sin mostrar el mensaje completo, que puede llevar rutas o datos internos.
 */
export function errorCode(err: unknown): string | null {
  const e = err as { code?: unknown; name?: unknown; Code?: unknown };
  for (const value of [e?.Code, e?.code, e?.name]) {
    if (typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{1,39}$/.test(value) && value !== "Error") return value;
  }
  return null;
}

function filenameFromTitle(title: string | null, fallback: string, ext: string): string {
  const clean = (title ?? "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
  return clean ? `${clean}${ext}` : fallback;
}

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

  let stages = STAGES;
  const progress = async (stage: JobStage, fraction: number, force = false) => {
    const [from, to] = stages[stage];
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
  // Paso en curso: si algo falla de forma inesperada, se dice dónde (y se registra el detalle).
  let step = "preparar el trabajo";

  const importFromLink = async (video: typeof videos.$inferSelect, workDir: string): Promise<string> => {
    if (!video.sourceUrl) throw new JobError("import_failed", "Falta el enlace del video.", false);
    step = "descargar el enlace";
    await progress("downloading", 0, true);
    let downloaded;
    try {
      downloaded = await (deps.download ?? downloadFromUrl)(video.sourceUrl, workDir, {
        ytDlpPath: deps.ytDlpPath ?? "yt-dlp",
        proxyUrl: deps.downloadProxyUrl ?? null,
        proxyProblem: deps.downloadProxyProblem ?? null,
        ffmpegPath: deps.tools.ffmpegPath,
        maxBytes: deps.product.upload.maxBytes,
        maxDurationSeconds: deps.product.upload.maxDurationSeconds,
        signal: controller.signal,
        onProgress: (f) => void progress("downloading", f).catch(() => undefined),
      });
    } catch (err) {
      if (!(err instanceof DownloadError)) throw err;
      deps.log.warn(
        { jobId: job.id, host: new URL(video.sourceUrl).hostname, error: err.message, detail: err.detail },
        "no se pudo descargar el enlace",
      );
      if (!err.retryable) await rejectVideo(deps.db, video.id, err.message);
      throw new JobError("import_failed", err.message, err.retryable);
    }
    check();
    const ext = path.extname(downloaded.file).toLowerCase();
    const mimeType = MIME_BY_EXTENSION[ext] ?? "video/mp4";
    step = "guardar el video importado";
    await deps.storage.upload(downloaded.file, video.s3Key, mimeType);
    step = "registrar el video importado";
    await deps.db
      .update(videos)
      .set({
        status: "uploaded",
        sizeBytes: downloaded.sizeBytes,
        mimeType,
        originalFilename: filenameFromTitle(downloaded.title, video.originalFilename, ext || ".mp4"),
        uploadedAt: new Date(),
      })
      .where(eq(videos.id, video.id));
    await deps.db.insert(usage).values({
      userId: job.userId,
      videoId: video.id,
      metric: "storage_bytes",
      quantity: downloaded.sizeBytes,
      details: { event: "import_completed" },
    });
    await progress("downloading", 1, true);
    return downloaded.file;
  };

  try {
    await mkdir(dir, { recursive: true });
    const [video] = await deps.db
      .select()
      .from(videos)
      .where(and(eq(videos.id, job.videoId), eq(videos.userId, job.userId)));
    if (!video) throw new JobError("video_not_found", "El video ya no existe.", false);

    // 0. Video importado por enlace: se descarga aquí (nunca en la API) y se guarda en S3.
    let input: string;
    // También al REINTENTAR un enlace que no se pudo descargar (quedó rechazado y sin archivo):
    // se vuelve a descargar en lugar de buscar un original que nunca existió.
    const retryImport = video.status === "rejected" && Boolean(video.sourceUrl) && video.sizeBytes === 0;
    if (video.status === "importing" || retryImport) {
      if (retryImport) {
        await deps.db.update(videos).set({ status: "importing", rejectionReason: null }).where(eq(videos.id, video.id));
      }
      stages = (job.params as JobParams).downloadOnly ? DOWNLOAD_ONLY_STAGES : IMPORT_STAGES;
      input = await importFromLink(video, dir);
    } else {
      // 1. Preparar: descargar de S3 y comprobar el contenido real.
      step = "leer el video original";
      await progress("preparing", 0, true);
      input = path.join(dir, `input${path.extname(video.s3Key)}`);
      await deps.storage.download(video.s3Key, input, tick("preparing", video.sizeBytes * 1.25), controller.signal);
    }
    check();
    step = "revisar el video";

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

    // "Solo descargar": el video ya quedó guardado y revisado. Sin análisis ni clips (si después
    // quiere clips, la web crea otro trabajo con "Crear clips").
    if ((job.params as JobParams).downloadOnly) {
      // Que se vea en cualquier celular: Instagram y Facebook entregan a menudo VP9/AV1 y el iPhone
      // solo reproducía el audio. Se convierte a H.264 + AAC (lo compatible se copia tal cual).
      step = "preparar el video para el celular";
      const phoneFile = path.join(dir, "download.mp4");
      const converted = await makePhoneCompatible(deps.tools, input, phoneFile, info, {
        signal: controller.signal,
        onProgress: (sec) => void progress("preparing", sec / info.durationSeconds).catch(() => undefined),
      });
      check();
      step = "guardar el video";
      await deps.storage.upload(phoneFile, video.s3Key, "video/mp4");
      const sizeBytes = (await stat(phoneFile)).size;
      const [current] = await deps.db.select({ name: videos.originalFilename }).from(videos).where(eq(videos.id, video.id));
      await deps.db
        .update(videos)
        .set({ sizeBytes, mimeType: "video/mp4", originalFilename: (current?.name ?? video.originalFilename).replace(/\.[a-z0-9]{2,4}$/i, ".mp4") })
        .where(eq(videos.id, video.id));
      deps.log.info({ jobId: job.id, videoCodec: info.videoCodec, audioCodec: info.audioCodec, converted }, "video listo para descargar");
      await progress("preparing", 1, true);
      const computeUsd = Math.round((((Date.now() - startedAt) / 3_600_000) * deps.costPerHourUsd) * 1_000_000) / 1_000_000;
      return {
        clipCount: 0,
        downloadOnly: true,
        ai: "disabled",
        aiReason: "Solo descarga",
        vision: "disabled",
        costs: { transcriptionUsd: 0, textUsd: 0, visionUsd: 0, computeUsd, totalUsd: computeUsd },
      };
    }
    // Franjas negras "quemadas" en el video (p. ej. horizontal subido como vertical): se quitan.
    const contentBox = await detectContentBox(deps.tools, input, info, controller.signal);
    if (contentBox) deps.log.info({ jobId: job.id, contentBox }, "franjas negras detectadas");
    await progress("preparing", 1, true);

    // 2. Analizar EN PARALELO (ahorra minutos):
    //    a) señales por segundo con FFmpeg (volumen, picos de acción, movimiento);
    //    b) IA de audio: transcripción + momentos por contenido;
    //    c) IA de imágenes (experimental): lo que se ve en pantalla.
    //    Si la IA falla, el video se procesa igual y el resultado lo indica.
    step = "analizar el video";
    const parts = { signals: 0, ai: 0, vision: 0 };
    const report = (part: keyof typeof parts) => (fraction: number) => {
      parts[part] = Math.min(1, Math.max(0, fraction));
      return progress("analyzing", parts.signals * 0.5 + parts.ai * 0.25 + parts.vision * 0.25).catch(() => undefined);
    };
    //    La IA de imágenes prepara sus hojas en paralelo, pero no envía nada a OpenAI hasta que
    //    termina el análisis de texto: comparten el límite por minuto de la cuenta y el análisis de
    //    texto (el que elige los momentos) tiene prioridad.
    const aiPromise = runAI(deps, info, input, dir, controller.signal, async (f) => void (await report("ai")(f)));
    const [raw, ai, vision] = await Promise.all([
      analyzeSignals(deps.tools, input, info, dir, {
        signal: controller.signal,
        onProgress: (sec) => void report("signals")(sec / info.durationSeconds),
      }),
      aiPromise,
      runVision(deps, info, input, dir, contentBox, controller.signal, async (f) => void (await report("vision")(f)), aiPromise),
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

    step = "elegir los momentos";
    // 3. Elegir momentos con el score configurable (sin forzar una cantidad).
    const params = job.params as JobParams;
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

    step = "generar y guardar los clips";
    // Transcripción completa del video (la web la muestra en "Ver todo el video").
    if (ai.segments.length) {
      const fullFile = path.join(dir, "full.vtt");
      await writeFile(fullFile, toVtt(ai.segments));
      await deps.storage.upload(fullFile, fullTranscriptKey(job.userId, job.id), "text/vtt");
    }
    const requested = (job.params as JobParams).subtitleStyle;
    const subtitleStyle: SubtitleStyle = requested === "classic" || requested === "none" ? requested : "highlight";

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
      // Subtítulos del clip (tiempos relativos al clip): en archivo y, según el estilo elegido,
      // dibujados en el video.
      const clipSegments = segmentsForRange(ai.segments, moment.startSeconds, moment.endSeconds);
      let burn: { file: string; fontsDir: string } | undefined;
      if (subtitleStyle !== "none" && clipSegments.length) {
        const ass = buildAss(clipSegments, subtitleStyle, duration);
        if (ass) {
          const assFile = path.join(dir, `sub-${index}.ass`);
          await writeFile(assFile, ass);
          burn = { file: assFile, fontsDir: SUBTITLE_FONTS_DIR };
        }
      }
      // Encuadre por clip: sin franjas negras; sigue a quien habla (o al grupo) y, sin caras,
      // se centra donde está la acción. La voz de la transcripción dice cuándo cuenta la boca.
      const start = moment.startSeconds;
      const speaking = ai.segments.length
        ? (t: number) => ai.segments.some((s) => s.startSeconds <= start + t && start + t < s.endSeconds)
        : undefined;
      const crop = await chooseVerticalCrop(deps.tools, input, info, contentBox, segment, controller.signal, {
        faces: deps.faceTracking ?? false,
        speaking,
        onWarning: (message, err) => deps.log.warn({ jobId: job.id, clip: index, error: (err as Error).message }, message),
      });
      await renderVerticalClip(deps.tools, input, clipFile, segment, {
        signal: controller.signal,
        crop,
        subtitles: burn,
        onProgress: (sec) => {
          clipProgress[index] = Math.min(0.95, sec / duration);
          void reportClips();
        },
      });
      await renderThumbnail(deps.tools, input, thumbFile, moment.startSeconds + duration / 2, controller.signal, cropAt(crop, duration / 2));
      check();
      const key = `clips/${job.userId}/${job.id}/${index}.mp4`;
      const thumbKey = `thumbnails/${job.userId}/${job.id}/${index}.jpg`;
      await deps.storage.upload(clipFile, key, "video/mp4");
      await deps.storage.upload(thumbFile, thumbKey, "image/jpeg");

      let subtitleKeys: { srt: string; vtt: string } | null = null;
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
    step = "guardar el resultado";
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
      ...(vision.reason ? { visionReason: vision.reason } : {}),
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
    const code = errorCode(err);
    deps.log.warn({ jobId: job.id, step, code, error: (err as Error).message, stack: (err as Error).stack }, "error inesperado");
    throw new JobError(
      "unexpected",
      `Ocurrió un error temporal al ${step}${code ? ` (${code})` : ""}. Lo intentaremos de nuevo.`,
      true,
    );
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
  let step = "la preparación del audio";
  // Si la transcripción salió bien y lo que falla es el análisis, se conserva (ya se pagó): sirve
  // para subtítulos, títulos y la transcripción completa.
  let transcribed: Awaited<ReturnType<NonNullable<PipelineDeps["ai"]>["transcribe"]>> | null = null;
  try {
    const chunks = await extractAudioChunks(deps.tools, input, dir, {
      maxSeconds: Math.min(info.durationSeconds, deps.aiMaxAudioMinutes * 60),
      signal,
    });
    await onProgress(0.2);
    step = "la transcripción";
    const transcript = await deps.ai.transcribe(chunks);
    transcribed = transcript;
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
    step = "el análisis de momentos";
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
    const e = err as AIProviderError;
    deps.log.warn({ step, error: e.message, status: e.status, code: e.code }, "IA no disponible; se continúa solo con FFmpeg");
    // Solo se muestran mensajes propios (los de OpenAIProvider no incluyen contenido del usuario).
    const detail = err instanceof AIProviderError ? e.message : "error inesperado";
    if (transcribed) {
      return {
        status: "unavailable",
        reason: `falló ${step}: ${detail}`,
        segments: transcribed.segments,
        language: transcribed.language,
        usage: { ...transcribed.usage },
        transcribeCostUsd: transcribed.usage.estimatedCostUsd ?? 0,
      };
    }
    return { ...empty, status: "unavailable", reason: `falló ${step}: ${detail}` };
  }
}

interface VisionOutcome {
  status: "used" | "disabled" | "unavailable";
  reason?: string;
  frames: FrameScore[];
  intervalSeconds: number;
  usage: AIUsage;
}

/** Análisis de imágenes (experimental). Nunca hace fallar el trabajo. */
async function runVision(
  deps: PipelineDeps,
  info: ProbeResult,
  input: string,
  dir: string,
  box: import("./ffmpeg.js").ContentBox | null,
  signal: AbortSignal,
  onProgress: (fraction: number) => Promise<void>,
  /** Se espera a que termine (el análisis de texto) antes de enviar imágenes a OpenAI. */
  after?: Promise<unknown>,
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
    await after?.catch(() => undefined);
    // Tiempo máximo para empezar hojas nuevas: en videos largos el límite por minuto de la cuenta
    // puede hacerlo muy lento; lo que no alcance se omite y el video no espera de más.
    const deadline = Date.now() + (config.budgetSeconds ?? 180) * 1000;
    const result = await deps.ai.analyzeFrames(sheets, { deadline });
    const skipped = result.skippedSheets ?? 0;
    return {
      status: "used",
      frames: result.frames,
      intervalSeconds,
      usage: result.usage,
      ...(skipped > 0
        ? { reason: `incompleto: se analizaron ${sheets.length - skipped} de ${sheets.length} grupos de imágenes (límite de tiempo)` }
        : {}),
    };
  } catch (err) {
    if (signal.aborted) throw err;
    const e = err as AIProviderError;
    deps.log.warn({ error: e.message, status: e.status, code: e.code }, "análisis de imágenes no disponible");
    return { ...off, status: "unavailable", reason: err instanceof AIProviderError ? e.message : "error inesperado" };
  }
}

async function rejectVideo(db: Database, videoId: string, reason: string) {
  await db.update(videos).set({ status: "rejected", rejectionReason: reason }).where(eq(videos.id, videoId));
}
