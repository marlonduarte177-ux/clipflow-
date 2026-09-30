import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { selectMoments, type ProductConfig, type SignalSeries } from "@clipflow/shared";
import { reportProgress, schema, type Database, type Job, type JobStage } from "@clipflow/shared/db";
import { analyzeSignals, FfmpegError, probe, renderThumbnail, renderVerticalClip, type FfmpegTools } from "./ffmpeg.js";
import type { WorkerStorage } from "./storage.js";

const { clips, usage, videos } = schema;

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
export async function processAnalyzeJob(job: Job, deps: PipelineDeps): Promise<{ clipCount: number }> {
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
    await progress("preparing", 1, true);

    // 2. Analizar: señales reales por segundo (volumen y cambios de escena).
    const raw = await analyzeSignals(deps.tools, input, info, dir, {
      signal: controller.signal,
      onProgress: tick("analyzing", info.durationSeconds),
    });
    check();
    const signals: SignalSeries = { visual: raw.visual, ...(raw.audio ? { audio: raw.audio } : {}) };
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
    deps.log.info({ jobId: job.id, moments: moments.length, clipDuration }, "momentos elegidos");
    await progress("detecting_moments", 1, true);

    // 4. Generar clips verticales y miniaturas; subir a S3 con rutas fijas por trabajo.
    const outputs: { moment: (typeof moments)[number]; key: string; thumbKey: string }[] = [];
    for (const [index, moment] of moments.entries()) {
      const duration = moment.endSeconds - moment.startSeconds;
      const clipFile = path.join(dir, `clip-${index}.mp4`);
      const thumbFile = path.join(dir, `thumb-${index}.jpg`);
      await renderVerticalClip(deps.tools, input, clipFile, { startSeconds: moment.startSeconds, durationSeconds: duration }, {
        signal: controller.signal,
        onProgress: (s) => void progress("rendering_clips", (index + s / duration) / moments.length).catch(() => undefined),
      });
      await renderThumbnail(deps.tools, input, thumbFile, moment.startSeconds + duration / 2, controller.signal);
      check();
      const key = `clips/${job.userId}/${job.id}/${index}.mp4`;
      const thumbKey = `thumbnails/${job.userId}/${job.id}/${index}.jpg`;
      await deps.storage.upload(clipFile, key, "video/mp4");
      await deps.storage.upload(thumbFile, thumbKey, "image/jpeg");
      outputs.push({ moment, key, thumbKey });
      await progress("rendering_clips", (index + 1) / moments.length, true);
    }

    // 5. Registrar resultados y consumo (en una transacción).
    await progress("finalizing", 0, true);
    const processingSeconds = (Date.now() - startedAt) / 1000;
    await deps.db.transaction(async (tx) => {
      await tx.delete(clips).where(eq(clips.jobId, job.id)); // reintento: reemplaza, no duplica
      if (outputs.length > 0) {
        await tx.insert(clips).values(
          outputs.map(({ moment, key, thumbKey }) => ({
            userId: job.userId,
            videoId: job.videoId,
            jobId: job.id,
            startSeconds: moment.startSeconds,
            endSeconds: moment.endSeconds,
            aspectRatio: "9:16" as const,
            score: moment.score,
            scoreBreakdown: moment.breakdown,
            s3Key: key,
            thumbnailS3Key: thumbKey,
          })),
        );
      }
      const base = { userId: job.userId, jobId: job.id, videoId: job.videoId };
      await tx.insert(usage).values([
        { ...base, metric: "video_seconds_processed", quantity: info.durationSeconds },
        {
          ...base,
          metric: "processing_seconds",
          quantity: processingSeconds,
          estimatedCostUsd: (processingSeconds / 3600) * deps.costPerHourUsd,
          details: { workerId: deps.workerId, attempt: job.attempts },
        },
        { ...base, metric: "clips_generated", quantity: outputs.length },
      ]);
    });
    return { clipCount: outputs.length };
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

async function rejectVideo(db: Database, videoId: string, reason: string) {
  await db.update(videos).set({ status: "rejected", rejectionReason: reason }).where(eq(videos.id, videoId));
}
