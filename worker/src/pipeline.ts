import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { readFile, writeFile } from "node:fs/promises";
import {
  bestFrameLabel,
  clampToRange,
  clipDurationRange,
  fitToSentences,
  fullTranscriptKey,
  isBillingExempt,
  minutesForSeconds,
  NO_MINUTES_CODE,
  reactionSignalFromSounds,
  transcriptCacheKey,
  segmentsForRange,
  selectAiMoments,
  selectMoments,
  speechSignalFromHighlights,
  toSrt,
  toVtt,
  visionSignalFromFrames,
  type AIAnalysisProvider,
  type AnalysisPipeline,
  type FrameScore,
  type SoundEvent,
  type SoundKind,
  type VideoFrame,
  type AIUsage,
  type JobParams,
  type JobResult,
  type ProductConfig,
  type SignalSeries,
  type SubtitleStyle,
  type TranscriptSegment,
} from "@clipflow/shared";
import {
  chargeVideoMinutes,
  InsufficientCreditsError,
  reportProgress,
  schema,
  type Database,
  type Job,
  type JobStage,
} from "@clipflow/shared/db";
import {
  analyzeSignals,
  buildFrameSheets,
  chooseVerticalCrop,
  cropAt,
  detectContentBox,
  extractAudioChunks,
  extractFrames,
  FfmpegError,
  makePhoneCompatible,
  probe,
  renderThumbnail,
  renderVerticalClip,
  verticalFilter,
  type FfmpegTools,
  type ProbeResult,
} from "./ffmpeg.js";
import type { WorkerStorage } from "./storage.js";
import { AIProviderError } from "./ai/openai.js";
import { buildAss, SUBTITLE_FONTS_DIR } from "./subtitles.js";
import {
  DownloadError,
  downloadFromUrl,
  downloadSection,
  fetchMediaInfo,
  isStreamPlatformUrl,
  resolveStreamUrls,
  type DownloadOptions,
  type StreamSource,
} from "./download.js";
import { fetchTwitchChatActivity, twitchVideoId } from "./chat/twitch.js";
import { detectSounds } from "./sounds/detect.js";

const { clips, subtitles, usage, users, videos } = schema;

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
  /**
   * Versión nueva del análisis: modelo de gama alta que además "oye" los sonidos (risas, gritos…) y
   * "ve" fotogramas en baja resolución. null = no configurada.
   */
  aiV2?: AIAnalysisProvider | null;
  /** Versión que usan los trabajos normales (la prueba lado a lado elige la suya). Por defecto "classic". */
  defaultPipeline?: AnalysisPipeline;
  /** Fotogramas de la versión nueva: uno cada 5–10 s según el largo del video. */
  frames?: { minIntervalSeconds: number; maxIntervalSeconds: number };
  /** Detector de sonidos (se reemplaza en tests; false = apagado). */
  detectSounds?: typeof detectSounds | false;
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
  /** Streams largos: datos del enlace, URLs del video y tramos (se reemplazan en tests). */
  streams?: {
    fetchMediaInfo?: typeof fetchMediaInfo;
    resolveStreamUrls?: typeof resolveStreamUrls;
    downloadSection?: typeof downloadSection;
  };
  /** Lee el chat de los VODs de Twitch como señal extra (se reemplaza en tests; false = no leerlo). */
  twitchChat?: typeof fetchTwitchChatActivity | false;
  /** Desde esta duración, un video guardado de Kick/Twitch se analiza con copia liviana (s). */
  longStreamMinSeconds?: number;
  /** Pagos: con `enabled`, cada video descuenta sus minutos del plan (salvo los correos exentos). */
  billing?: { enabled: boolean; freeEmails?: string };
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

/** Desde esta duración, un video guardado de Kick/Twitch se analiza con una copia liviana (10 min). */
const LONG_STREAM_MIN_SECONDS = 10 * 60;

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

  const linkOptions = (): DownloadOptions => ({
    ytDlpPath: deps.ytDlpPath ?? "yt-dlp",
    proxyUrl: deps.downloadProxyUrl ?? null,
    proxyProblem: deps.downloadProxyProblem ?? null,
    ffmpegPath: deps.tools.ffmpegPath,
    maxBytes: deps.product.upload.maxBytes,
    maxDurationSeconds: deps.product.upload.maxDurationSeconds,
    signal: controller.signal,
  });

  /**
   * Importa el enlace. Un video guardado LARGO de Kick o Twitch (para crear clips) no se baja entero
   * en 720p: se baja una copia liviana (160p, ~100 MB por hora) para elegir los momentos, y después
   * solo los tramos de los clips en 720p. Devuelve si quedó como copia liviana.
   */
  const importFromLink = async (video: typeof videos.$inferSelect, workDir: string): Promise<{ file: string; analysisCopy: boolean }> => {
    if (!video.sourceUrl) throw new JobError("import_failed", "Falta el enlace del video.", false);
    step = "descargar el enlace";
    await progress("downloading", 0, true);
    let downloaded;
    let analysisCopy = false;
    try {
      if (!(job.params as JobParams).downloadOnly && isStreamPlatformUrl(video.sourceUrl)) {
        const media = await (deps.streams?.fetchMediaInfo ?? fetchMediaInfo)(video.sourceUrl, linkOptions());
        analysisCopy = !media.isLive && (media.durationSeconds ?? 0) >= (deps.longStreamMinSeconds ?? LONG_STREAM_MIN_SECONDS);
      }
      downloaded = await (deps.download ?? downloadFromUrl)(video.sourceUrl, workDir, {
        ...linkOptions(),
        ...(analysisCopy ? { quality: "analysis" as const } : {}),
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
        // La marca se guarda YA: si el trabajo falla antes de terminar, el reintento sabe que es una
        // copia liviana (y no hace clips en 160p).
        ...(analysisCopy ? { probe: { clipflowAnalysisCopy: true } } : {}),
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
    if (analysisCopy) deps.log.info({ jobId: job.id, sizeBytes: downloaded.sizeBytes }, "stream largo: copia liviana para analizar");
    return { file: downloaded.file, analysisCopy };
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
    // Stream largo analizado con copia liviana: los clips se cortan del enlace en 720p. Se recuerda
    // en el video (`probe.clipflowAnalysisCopy`) para reprocesar igual sin volver a bajar la copia.
    let analysisCopy = Boolean((video.probe as { clipflowAnalysisCopy?: boolean } | null)?.clipflowAnalysisCopy);
    // También al REINTENTAR un enlace que no se pudo descargar (quedó rechazado y sin archivo):
    // se vuelve a descargar en lugar de buscar un original que nunca existió.
    const retryImport = video.status === "rejected" && Boolean(video.sourceUrl) && video.sizeBytes === 0;
    if (video.status === "importing" || retryImport) {
      if (retryImport) {
        await deps.db.update(videos).set({ status: "importing", rejectionReason: null }).where(eq(videos.id, video.id));
      }
      stages = (job.params as JobParams).downloadOnly ? DOWNLOAD_ONLY_STAGES : IMPORT_STAGES;
      ({ file: input, analysisCopy } = await importFromLink(video, dir));
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
      .set({
        status: "ready",
        durationSeconds: info.durationSeconds,
        width: info.width,
        height: info.height,
        probe: analysisCopy ? { ...(info.raw as object), clipflowAnalysisCopy: true } : info.raw,
      })
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
    // Minutos del plan: se descuentan ahora que se sabe cuánto dura (si falla o se cancela, se devuelven).
    await chargeMinutes(deps, job, video.id, info.durationSeconds);

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
    // Duración elegida: guía a la IA sobre el largo de cada momento y fija el de los clips por señales.
    const params = job.params as JobParams;
    const clipDuration = deps.product.clipDurationsSeconds.includes(params.clipDurationSeconds ?? -1)
      ? params.clipDurationSeconds!
      : deps.product.defaultClipDurationSeconds;
    // Versión del análisis: la del trabajo (prueba lado a lado) o la del servidor.
    const pipeline: AnalysisPipeline = (params.pipeline ?? deps.defaultPipeline ?? "classic") === "v2" && deps.aiV2 ? "v2" : "classic";
    const aiProvider = pipeline === "v2" ? deps.aiV2! : deps.ai;
    const aiPromise = runAI(deps, aiProvider, info, input, dir, controller.signal, async (f) => void (await report("ai")(f)), {
      userId: job.userId,
      videoId: video.id,
      jobId: job.id,
      sourceUrl: video.sourceUrl,
      targetClipSeconds: clipDuration,
      canRetry: job.attempts < job.maxAttempts,
      pipeline,
      box: contentBox,
      skipTranscriptCache: params.skipTranscriptCache === true,
    });
    // Las imágenes esperan al análisis de texto; si el trabajo se va a reintentar por OpenAI saturado,
    // no se gastan imágenes ahora. (Se marca como manejada: con la visión apagada nadie la espera.)
    const visionGate = aiPromise.then((a) => {
      if (a.retryLater) throw new Error("se reintentará");
    });
    visionGate.catch(() => undefined);
    const chatPromise = readTwitchChat(deps, video.sourceUrl, info.durationSeconds, controller.signal, job.id);
    const [raw, ai, vision, chat] = await Promise.all([
      analyzeSignals(deps.tools, input, info, dir, {
        signal: controller.signal,
        onProgress: (sec) => void report("signals")(sec / info.durationSeconds),
      }),
      aiPromise,
      // La versión nueva ya le muestra los fotogramas a la IA que elige los momentos.
      pipeline === "v2"
        ? Promise.resolve<VisionOutcome>({ status: "disabled", frames: [], intervalSeconds: 0, usage: {} })
        : runVision(deps, info, input, dir, contentBox, controller.signal, async (f) => void (await report("vision")(f)), visionGate),
      chatPromise,
    ]);
    check();
    if (ai.retryLater) {
      throw new JobError(
        "ai_busy",
        "OpenAI está saturado por ahora (límite de uso por minuto de tu cuenta). Lo reintentamos en unos minutos; la transcripción ya quedó guardada.",
        true,
      );
    }
    const signals: SignalSeries = {
      visual: raw.visual,
      ...(raw.audio ? { audio: raw.audio } : {}),
      ...(raw.action ? { action: raw.action } : {}),
    };
    if (ai.highlights) signals.speech = speechSignalFromHighlights(ai.highlights, info.durationSeconds);
    if (vision.frames.length) {
      signals.vision = visionSignalFromFrames(vision.frames, info.durationSeconds, vision.intervalSeconds);
    }
    if (chat.status === "used") signals.chat = chat.series;
    // Versión nueva: risas, gritos, aplausos y vítores como señal de reacción.
    if (ai.sounds?.length) signals.reaction = reactionSignalFromSounds(ai.sounds, info.durationSeconds);
    await progress("analyzing", 1, true);

    step = "elegir los momentos";
    // 3. Elegir momentos (sin forzar una cantidad):
    //    - con voz y análisis de IA (podcasts, entrevistas, streams hablados), la IA decide: cada clip es
    //      un momento que ella eligió, con su inicio y su final; las demás señales solo desempatan;
    //    - sin voz o sin IA (gameplay, música, IA caída), score por señales con ventanas del largo elegido.
    const aiMoments = ai.status === "used" && ai.highlights?.length
      ? selectAiMoments({
          highlights: ai.highlights,
          durationSeconds: info.durationSeconds,
          signals,
          weights: deps.product.scoreWeights,
          clipDurationSeconds: clipDuration,
          maxClips: deps.product.maxClipsPerVideo,
          segments: ai.segments,
          sounds: ai.sounds,
        })
      : [];
    const selection = aiMoments.length ? "ai" : "signals";
    const moments = aiMoments.length
      ? aiMoments
      : selectMoments({
          durationSeconds: info.durationSeconds,
          signals,
          weights: deps.product.scoreWeights,
          clipDurationSeconds: clipDuration,
          minScore: deps.product.minClipScore,
          maxClips: deps.product.maxClipsPerVideo,
        });
    // Largo obligatorio (duración elegida ±5 s). Los momentos de la IA ya vienen ajustados en frases;
    // los demás se ajustan aquí: en frases completas si hay transcripción, si no, a la medida.
    const bounds = { ...clipDurationRange(clipDuration), videoDurationSeconds: info.durationSeconds };
    const finalMoments =
      selection === "ai"
        ? moments
        : moments.map((m) => ({
            ...m,
            ...(fitToSentences(m.startSeconds, m.endSeconds, ai.segments, bounds) ?? clampToRange(m.startSeconds, m.endSeconds, bounds)),
          }));
    // La versión nueva ya propone un título con gancho por momento; los que falten se piden aparte.
    let titles: (string | null)[] = finalMoments.map((m) => m.title ?? null);
    if (aiProvider && ai.segments.length && titles.some((t) => t === null)) {
      try {
        const suggestion = await aiProvider.generateClipSuggestions(ai.segments, finalMoments);
        titles = titles.map((t, i) => t ?? suggestion.titles[i] ?? null);
        addUsage(ai.usage, suggestion.usage);
      } catch (err) {
        deps.log.warn({ jobId: job.id, error: (err as Error).message }, "no se pudieron generar títulos");
      }
    }
    // Sin título de la transcripción (p. ej. gameplay sin voz): lo que se ve en el mejor fotograma.
    titles = titles.map((t, i) => t ?? bestFrameLabel(vision.frames, finalMoments[i]!.startSeconds, finalMoments[i]!.endSeconds));
    deps.log.info(
      {
        jobId: job.id,
        moments: finalMoments.length,
        selection,
        clipDuration,
        pipeline,
        ai: ai.status,
        vision: vision.status,
        chat: chat.status,
        sounds: ai.sounds?.length,
        frames: ai.frames,
      },
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

    // Stream largo: las direcciones del video en 720p se piden una vez; cada clip baja solo su tramo.
    let streamSource: StreamSource | null = null;
    if (analysisCopy && finalMoments.length) {
      if (!video.sourceUrl) throw new JobError("source_missing", "Falta el enlace del video para cortar los clips.", false);
      try {
        streamSource = await (deps.streams?.resolveStreamUrls ?? resolveStreamUrls)(video.sourceUrl, linkOptions());
      } catch (err) {
        if (!(err instanceof DownloadError)) throw err;
        deps.log.warn({ jobId: job.id, error: err.message, detail: err.detail }, "no se pudo abrir el video original");
        throw new JobError("source_failed", `No pudimos abrir el video original para cortar los clips: ${err.message}`, err.retryable);
      }
    }
    /** De dónde sale cada clip: el video completo, o (stream largo) su tramo en 720p recién bajado. */
    const clipSource = async (index: number, moment: (typeof finalMoments)[number]) => {
      if (!streamSource) return { file: input, info, box: contentBox, offset: 0 };
      const file = path.join(dir, `section-${index}.mp4`);
      const get = deps.streams?.downloadSection ?? downloadSection;
      const run = () =>
        get(streamSource!, moment.startSeconds, moment.endSeconds - moment.startSeconds, file, {
          ffmpegPath: deps.tools.ffmpegPath,
          signal: controller.signal,
        });
      try {
        await run().catch(async (err: unknown) => {
          if (!(err instanceof DownloadError) || controller.signal.aborted) throw err;
          await run(); // un reintento: los cortes de red en tramos cortos son comunes
        });
      } catch (err) {
        if (!(err instanceof DownloadError)) throw err;
        deps.log.warn({ jobId: job.id, clip: index, detail: err.detail }, "no se pudo bajar el tramo del clip");
        throw new JobError("section_failed", err.message, true);
      }
      const sectionInfo = await probe(deps.tools, file);
      return { file, info: sectionInfo, box: await detectContentBox(deps.tools, file, sectionInfo, controller.signal), offset: moment.startSeconds };
    };

    const renderOne = async (index: number) => {
      const moment = finalMoments[index]!;
      const duration = moment.endSeconds - moment.startSeconds;
      const clipFile = path.join(dir, `clip-${index}.mp4`);
      const thumbFile = path.join(dir, `thumb-${index}.jpg`);
      const source = await clipSource(index, moment);
      const segment = { startSeconds: moment.startSeconds - source.offset, durationSeconds: duration };
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
      const crop = await chooseVerticalCrop(deps.tools, source.file, source.info, source.box, segment, controller.signal, {
        faces: deps.faceTracking ?? false,
        speaking,
        onWarning: (message, err) => deps.log.warn({ jobId: job.id, clip: index, error: (err as Error).message }, message),
      });
      try {
        await renderVerticalClip(deps.tools, source.file, clipFile, segment, {
          signal: controller.signal,
          crop,
          subtitles: burn,
          onProgress: (sec) => {
            clipProgress[index] = Math.min(0.95, sec / duration);
            void reportClips();
          },
        });
        await renderThumbnail(deps.tools, source.file, thumbFile, segment.startSeconds + duration / 2, controller.signal, cropAt(crop, duration / 2));
      } catch (err) {
        // Solo medidas (sin contenido): para entender por qué FFmpeg rechaza un recorte.
        if (err instanceof FfmpegError && !controller.signal.aborted) {
          const { path: pieces, ...fixed } = crop;
          const { raw: _raw, ...sourceInfo } = source.info;
          deps.log.warn(
            {
              jobId: job.id,
              clip: index,
              section: source.file !== input,
              source: sourceInfo,
              box: source.box,
              segment,
              crop: { ...fixed, pieces: pieces?.length ?? 0 },
              filter: verticalFilter(crop).slice(0, 600),
            },
            "no se pudo generar el clip",
          );
        }
        throw err;
      }
      if (source.file !== input) await rm(source.file, { force: true }); // el tramo ya no hace falta
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
              aiReason: moment.reason ?? null,
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
                details: { provider: aiProvider?.name, model: aiProvider?.transcriptionModel },
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
                details: { provider: aiProvider?.name, model: aiProvider?.analysisModel, kind: "text", pipeline },
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
                details: { provider: aiProvider?.name, kind: "vision", frames: vision.frames.length },
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
      selection,
      ai: ai.status,
      ...(ai.reason ? { aiReason: ai.reason } : {}),
      pipeline,
      ...(aiProvider ? { models: { transcription: aiProvider.transcriptionModel, analysis: aiProvider.analysisModel } } : {}),
      ...(ai.sounds ? { sounds: countSounds(ai.sounds) } : {}),
      ...(ai.frames !== undefined ? { analysisFrames: ai.frames } : {}),
      language: ai.language,
      vision: vision.status,
      ...(vision.reason ? { visionReason: vision.reason } : {}),
      visionFrames: vision.frames.length,
      ...(chat.status ? { chat: chat.status, chatMessages: chat.messages } : {}),
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

type Transcribed = Awaited<ReturnType<NonNullable<PipelineDeps["ai"]>["transcribe"]>>;

/** Vuelta del trabajo: el mismo id con otra entrada a la cola (Reintentar) es otra vuelta. */
export function jobRun(job: Pick<Job, "id" | "queuedAt">): string {
  return `${job.id}@${job.queuedAt.toISOString()}`;
}

/** Descuenta los minutos del video. Sin minutos suficientes el trabajo termina con un mensaje claro. */
async function chargeMinutes(deps: PipelineDeps, job: Job, videoId: string, durationSeconds: number): Promise<void> {
  if (!deps.billing?.enabled) return;
  const [owner] = await deps.db.select({ email: users.email }).from(users).where(eq(users.id, job.userId));
  if (isBillingExempt(owner?.email, deps.billing.freeEmails)) return;
  const minutes = minutesForSeconds(durationSeconds);
  try {
    const { charged, balance } = await chargeVideoMinutes(deps.db, { userId: job.userId, videoId, run: jobRun(job), minutes });
    if (charged) deps.log.info({ jobId: job.id, minutes: charged, balance }, "minutos descontados");
  } catch (err) {
    if (!(err instanceof InsufficientCreditsError)) throw err;
    throw new JobError(
      NO_MINUTES_CODE,
      `Este video dura ${minutes} min y te quedan ${err.balance} min de tu plan. Se recargan con la próxima renovación.`,
      false,
    );
  }
}

/** Transcripción guardada por video (ver `transcriptCacheKey`). */
const CachedTranscript = z.object({
  version: z.literal(1),
  coveredSeconds: z.number(),
  analyzedSeconds: z.number(),
  language: z.string().nullable(),
  segments: z.array(
    z.object({
      startSeconds: z.number(),
      endSeconds: z.number(),
      text: z.string(),
      words: z.array(z.object({ startSeconds: z.number(), endSeconds: z.number(), text: z.string() })).optional(),
    }),
  ),
});

/**
 * Lee la transcripción guardada del video. Solo se usa si cubre el MISMO tramo de audio (el modelo ya
 * va en la ruta). Si no existe o no sirve, devuelve null y se transcribe normalmente.
 */
async function loadTranscript(deps: PipelineDeps, key: string, coveredSeconds: number, file: string) {
  try {
    await deps.storage.download(key, file);
    const parsed = CachedTranscript.safeParse(JSON.parse(await readFile(file, "utf8")));
    if (!parsed.success || Math.abs(parsed.data.coveredSeconds - coveredSeconds) > 1) return null;
    return parsed.data;
  } catch {
    return null; // No existe todavía (lo normal la primera vez).
  } finally {
    await rm(file, { force: true });
  }
}

/** Guarda la transcripción del video. Si falla, solo se registra: el trabajo sigue. */
async function saveTranscript(
  deps: PipelineDeps,
  key: string,
  file: string,
  data: Omit<z.infer<typeof CachedTranscript>, "version">,
) {
  try {
    await writeFile(file, JSON.stringify({ version: 1, ...data }));
    await deps.storage.upload(file, key, "application/json");
  } catch (err) {
    deps.log.warn({ error: (err as Error).message }, "no se pudo guardar la transcripción para reutilizarla");
  } finally {
    await rm(file, { force: true });
  }
}

interface AIOutcome {
  status: JobResult["ai"];
  reason?: string;
  segments: TranscriptSegment[];
  /** Versión nueva: sonidos detectados y cuántos fotogramas vio la IA. */
  sounds?: SoundEvent[];
  frames?: number;
  highlights?: import("@clipflow/shared").ContentHighlight[];
  language: string | null;
  usage: AIUsage;
  transcribeCostUsd: number;
  /**
   * OpenAI falló por algo temporal (límite por minuto, error 5xx) y quedan intentos: el trabajo se
   * reintenta en unos minutos (con la transcripción guardada) en vez de elegir clips sin la IA.
   */
  retryLater?: boolean;
}

function addUsage(total: AIUsage, extra: AIUsage) {
  total.inputTokens = (total.inputTokens ?? 0) + (extra.inputTokens ?? 0);
  total.outputTokens = (total.outputTokens ?? 0) + (extra.outputTokens ?? 0);
  total.estimatedCostUsd = (total.estimatedCostUsd ?? 0) + (extra.estimatedCostUsd ?? 0);
}

/** Transcripción + análisis con IA. Nunca hace fallar el trabajo: si algo falla, lo informa. */
/**
 * Chat del VOD de Twitch (solo enlaces twitch.tv/videos/…). Nunca hace fallar el trabajo:
 * si no se puede leer, los momentos se eligen con las demás señales.
 */
async function readTwitchChat(
  deps: PipelineDeps,
  sourceUrl: string | null,
  durationSeconds: number,
  signal: AbortSignal,
  jobId: string,
): Promise<{ status?: "used" | "unavailable"; series: number[]; messages: number }> {
  const videoId = twitchVideoId(sourceUrl);
  if (!videoId || deps.twitchChat === false) return { series: [], messages: 0 };
  const read = deps.twitchChat ?? fetchTwitchChatActivity;
  try {
    // Como mucho 2 minutos: es una señal extra, no debe frenar el análisis.
    const activity = await read(videoId, durationSeconds, { signal, deadline: Date.now() + 120_000 });
    if (!activity) return { status: "unavailable", series: [], messages: 0 };
    deps.log.info({ jobId, messages: activity.messages, samples: activity.samples }, "chat de Twitch leído");
    return { status: "used", series: activity.series, messages: activity.messages };
  } catch (err) {
    deps.log.warn({ jobId, error: (err as Error).message }, "no se pudo leer el chat de Twitch");
    return { status: "unavailable", series: [], messages: 0 };
  }
}

/**
 * Versión de las transcripciones guardadas. "-sync": desde que el audio se alinea con el inicio del
 * video (antes, si el audio empezaba más tarde, los tiempos quedaban corridos). Las viejas no se reusan.
 */
const TRANSCRIPT_CACHE_VERSION = "-sync";

async function runAI(
  deps: PipelineDeps,
  provider: AIAnalysisProvider | null,
  info: ProbeResult,
  input: string,
  dir: string,
  signal: AbortSignal,
  onProgress: (fraction: number) => Promise<void>,
  ids: {
    userId: string;
    videoId: string;
    jobId: string;
    sourceUrl?: string | null;
    targetClipSeconds?: number;
    /** Quedan intentos del trabajo: un fallo temporal de OpenAI se reintenta más tarde. */
    canRetry?: boolean;
    /** "v2": además se detectan los sonidos y se sacan fotogramas para la IA. */
    pipeline?: AnalysisPipeline;
    /** Zona del video sin franjas negras (para los fotogramas). */
    box?: import("./ffmpeg.js").ContentBox | null;
    /** No reutilizar transcripciones guardadas (prueba lado a lado: costo real). */
    skipTranscriptCache?: boolean;
  },
): Promise<AIOutcome> {
  const empty = { segments: [], language: null, usage: {}, transcribeCostUsd: 0 };
  if (!provider) return { ...empty, status: "disabled", reason: deps.aiDisabledReason ?? "IA no configurada" };
  if (!info.hasAudio) return { ...empty, status: "no_audio", reason: "El video no tiene audio" };
  const ai = provider;
  let step = "la preparación del audio";
  // Si la transcripción salió bien y lo que falla es el análisis, se conserva (ya se pagó): sirve
  // para subtítulos, títulos y la transcripción completa.
  let transcribed: Transcribed | null = null;
  let noSpeech = false;
  const coveredSeconds = Math.min(info.durationSeconds, deps.aiMaxAudioMinutes * 60);
  // Versión nueva: MIENTRAS se transcribe, el procesador detecta los sonidos y saca los fotogramas
  // (todo local, sin costo de API). Nunca falla: si algo no sale, la IA sigue con lo demás.
  const extrasPromise = ids.pipeline === "v2" ? v2Extras(deps, input, dir, info, ids.box ?? null, coveredSeconds, signal, ids.jobId) : null;
  try {
    // ¿Ya se transcribió este video (reintento o nuevo procesamiento)? Se reutiliza: no se paga otra vez.
    const cacheKey = ai.transcriptionModel
      ? transcriptCacheKey(ids.userId, ids.videoId, ai.name, `${ai.transcriptionModel}${TRANSCRIPT_CACHE_VERSION}`)
      : null;
    const cacheFile = path.join(dir, "transcript-cache.json");
    let cached = cacheKey && !ids.skipTranscriptCache ? await loadTranscript(deps, cacheKey, coveredSeconds, cacheFile) : null;
    // El MISMO enlace importado otra vez es otro video en ClipFlow: se busca la transcripción de los
    // videos anteriores de ESTE usuario con ese enlace (nunca de otros usuarios). Solo si duran lo
    // mismo: si el anterior se bajó desde otro punto (o el stream seguía creciendo), sus tiempos no
    // coinciden con este video y los subtítulos quedarían corridos.
    if (!cached && cacheKey && ids.sourceUrl && ai.transcriptionModel && !ids.skipTranscriptCache) {
      const earlier = await deps.db
        .select({ id: videos.id, durationSeconds: videos.durationSeconds })
        .from(videos)
        .where(and(eq(videos.userId, ids.userId), eq(videos.sourceUrl, ids.sourceUrl), ne(videos.id, ids.videoId)))
        .orderBy(desc(videos.createdAt))
        .limit(5);
      for (const other of earlier) {
        if (other.durationSeconds == null || Math.abs(other.durationSeconds - info.durationSeconds) > 1) continue;
        const otherKey = transcriptCacheKey(ids.userId, other.id, ai.name, `${ai.transcriptionModel}${TRANSCRIPT_CACHE_VERSION}`);
        cached = await loadTranscript(deps, otherKey, coveredSeconds, cacheFile);
        if (cached) {
          // Copia propia para este video (se borra con él, igual que la original con el suyo).
          await saveTranscript(deps, cacheKey, cacheFile, {
            coveredSeconds: cached.coveredSeconds,
            analyzedSeconds: cached.analyzedSeconds,
            language: cached.language,
            segments: cached.segments,
          });
          break;
        }
      }
    }
    let transcript: Transcribed;
    let analyzedSeconds: number;
    if (cached) {
      transcript = { segments: cached.segments, language: cached.language, usage: {} };
      analyzedSeconds = cached.analyzedSeconds;
      deps.log.info({ jobId: ids.jobId, segments: cached.segments.length }, "transcripción reutilizada (sin costo)");
      await onProgress(0.7);
    } else {
      const chunks = await extractAudioChunks(deps.tools, input, dir, { maxSeconds: coveredSeconds, signal });
      await onProgress(0.2);
      step = "la transcripción";
      transcript = await ai.transcribe(chunks);
      analyzedSeconds = chunks.reduce((sum, c) => sum + c.durationSeconds, 0);
      if (cacheKey) {
        await saveTranscript(deps, cacheKey, path.join(dir, "transcript-cache.json"), {
          coveredSeconds,
          analyzedSeconds,
          language: transcript.language,
          segments: transcript.segments,
        });
      }
      await onProgress(0.7);
    }
    transcribed = transcript;

    // Sin habla real (p. ej. gameplay o música): no se inventan títulos ni subtítulos. La versión
    // actual elige por acción, sonido y movimiento; la nueva deja que la IA elija por lo que ve y oye.
    const speechSeconds = transcript.segments.reduce((sum, s) => sum + (s.endSeconds - s.startSeconds), 0);
    noSpeech = speechSeconds < Math.max(15, analyzedSeconds * 0.1);
    const extras = extrasPromise ? await extrasPromise : null;
    if (noSpeech && !(extras && (extras.frames.length || extras.sounds.length))) {
      return {
        status: "no_speech",
        reason: "No se detectó habla (p. ej. gameplay o música); los clips se eligieron por acción, sonido y movimiento",
        segments: [],
        language: null,
        usage: { ...transcript.usage },
        transcribeCostUsd: transcript.usage.estimatedCostUsd ?? 0,
        ...(extras ? { sounds: extras.sounds, frames: extras.frames.length } : {}),
      };
    }
    step = "el análisis de momentos";
    const segments = noSpeech ? [] : transcript.segments;
    const analysis = await ai.analyze(segments, info.durationSeconds, {
      targetClipSeconds: ids.targetClipSeconds,
      ...(extras ? { sounds: extras.sounds, frames: extras.frames } : {}),
    });
    const usage: AIUsage = { ...transcript.usage };
    const transcribeCostUsd = transcript.usage.estimatedCostUsd ?? 0;
    addUsage(usage, analysis.usage);
    return {
      status: "used",
      ...(noSpeech ? { reason: "No se detectó habla: la IA eligió por lo que se ve y se oye" } : {}),
      segments,
      highlights: analysis.highlights,
      language: noSpeech ? null : transcript.language,
      usage,
      transcribeCostUsd,
      ...(extras ? { sounds: extras.sounds, frames: extras.frames.length } : {}),
    };
  } catch (err) {
    if (signal.aborted) throw err;
    const extras = extrasPromise ? await extrasPromise : null;
    const e = err as AIProviderError;
    // Solo lo que se recupera solo en minutos: límite por minuto (429), errores de OpenAI (5xx) o la red.
    const temporary =
      err instanceof AIProviderError && e.retryable && (e.status === 429 || (e.status ?? 0) >= 500 || /^No se pudo conectar con OpenAI$/.test(e.message));
    const retryLater = temporary && ids.canRetry === true;
    deps.log.warn(
      { step, error: e.message, status: e.status, code: e.code, limit: e.limit, retryLater },
      retryLater ? "IA saturada; el trabajo se reintentará más tarde" : "IA no disponible; se continúa solo con FFmpeg",
    );
    // Solo se muestran mensajes propios (los de OpenAIProvider no incluyen contenido del usuario).
    const detail = err instanceof AIProviderError ? e.message : "error inesperado";
    const soundsPart = extras ? { sounds: extras.sounds, frames: 0 } : {};
    if (transcribed) {
      return {
        status: "unavailable",
        reason: `falló ${step}: ${detail}`,
        segments: noSpeech ? [] : transcribed.segments,
        language: noSpeech ? null : transcribed.language,
        usage: { ...transcribed.usage },
        transcribeCostUsd: transcribed.usage.estimatedCostUsd ?? 0,
        retryLater,
        ...soundsPart,
      };
    }
    return { ...empty, status: "unavailable", reason: `falló ${step}: ${detail}`, retryLater, ...soundsPart };
  }
}

/** Fotogramas de la versión nueva: uno cada 5 s en videos cortos, hasta uno cada 10 s desde 1 h. */
export function frameIntervalSeconds(durationSeconds: number, range = { minIntervalSeconds: 5, maxIntervalSeconds: 10 }): number {
  return Math.min(range.maxIntervalSeconds, Math.max(range.minIntervalSeconds, durationSeconds / 360));
}

/** Sonidos (detector local) y fotogramas en baja resolución para la versión nueva. Nunca falla. */
async function v2Extras(
  deps: PipelineDeps,
  input: string,
  dir: string,
  info: ProbeResult,
  box: import("./ffmpeg.js").ContentBox | null,
  maxSeconds: number,
  signal: AbortSignal,
  jobId: string,
): Promise<{ sounds: SoundEvent[]; frames: VideoFrame[] }> {
  const detector = deps.detectSounds === false ? null : (deps.detectSounds ?? detectSounds);
  const framesDir = path.join(dir, "frames");
  const soundsPromise = detector
    ? detector(deps.tools, input, { maxSeconds, signal }).catch((err: unknown) => {
        if (!signal.aborted) deps.log.warn({ jobId, error: (err as Error).message }, "no se pudieron detectar los sonidos");
        return [] as SoundEvent[];
      })
    : Promise.resolve([] as SoundEvent[]);
  const framesPromise = mkdir(framesDir, { recursive: true })
    .then(() => extractFrames(deps.tools, input, framesDir, info, { intervalSeconds: frameIntervalSeconds(info.durationSeconds, deps.frames), box, signal }))
    .catch((err: unknown) => {
      if (!signal.aborted) deps.log.warn({ jobId, error: (err as Error).message }, "no se pudieron sacar los fotogramas");
      return [] as VideoFrame[];
    });
  const [sounds, frames] = await Promise.all([soundsPromise, framesPromise]);
  deps.log.info({ jobId, sounds: countSounds(sounds), frames: frames.length }, "sonidos y fotogramas listos");
  return { sounds, frames };
}

/** Cuántos sonidos de cada tipo se detectaron (para el resultado y los registros). */
function countSounds(events: SoundEvent[]): Partial<Record<SoundKind, number>> {
  const counts: Partial<Record<SoundKind, number>> = {};
  for (const e of events) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  return counts;
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
    // Si el análisis de texto avisa que el trabajo se reintentará, no se envían imágenes.
    const go = await (after ?? Promise.resolve()).then(
      () => true,
      () => false,
    );
    if (!go) return off;
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
