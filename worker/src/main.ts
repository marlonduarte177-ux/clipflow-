import os from "node:os";
import { SQSClient } from "@aws-sdk/client-sqs";
import pino from "pino";
import { loadProductConfig } from "@clipflow/shared";
import { createDb, databaseUrlFromEnv } from "@clipflow/shared/db";
import { DeepgramTranscriber, looksLikeDeepgramKey, withDeepgram } from "./ai/deepgram.js";
import { OpenAIProvider } from "./ai/openai.js";
import { isApifyToken } from "./apify.js";
import { loadWorkerConfig, looksLikeOpenAIKey } from "./config.js";
import { runConsumer } from "./consumer.js";
import { createS3WorkerStorage } from "./storage.js";

const config = loadWorkerConfig();
const log = pino({ level: config.LOG_LEVEL, base: { service: "worker", env: config.APP_ENV } });
const database = createDb(databaseUrlFromEnv(), { ssl: config.DATABASE_SSL, maxConnections: 3 });
const workerId = `${os.hostname()}-${process.pid}`;

// IA: Whisper de OpenAI transcribe y GPT elige los momentos (una sola clave). Nunca se registra.
const openaiKey = config.OPENAI_API_KEY?.trim();
const ai =
  config.AI_PROVIDER === "openai" && looksLikeOpenAIKey(openaiKey)
    ? new OpenAIProvider({
        apiKey: openaiKey,
        transcribeModel: config.OPENAI_TRANSCRIBE_MODEL,
        analysisModel: config.OPENAI_ANALYSIS_MODEL,
        visionModel: config.OPENAI_VISION_MODEL || undefined,
        prices: {
          transcribePerMinuteUsd: config.OPENAI_TRANSCRIBE_COST_PER_MINUTE_USD,
          inputPer1MUsd: config.OPENAI_INPUT_COST_PER_1M_TOKENS_USD,
          cachedInputPer1MUsd: config.OPENAI_CACHED_INPUT_COST_PER_1M_TOKENS_USD,
          outputPer1MUsd: config.OPENAI_OUTPUT_COST_PER_1M_TOKENS_USD,
        },
      })
    : null;
// Versión nueva: la misma transcripción; los momentos los elige un modelo de gama alta que además oye los
// sonidos marcados y ve fotogramas en baja resolución. Misma clave.
const aiV2 =
  ai && openaiKey
    ? new OpenAIProvider({
        apiKey: openaiKey,
        transcribeModel: config.OPENAI_TRANSCRIBE_MODEL,
        analysisModel: config.OPENAI_V2_MODEL,
        analysisVersion: "v2",
        reasoningEffort: config.OPENAI_V2_REASONING_EFFORT,
        prices: {
          transcribePerMinuteUsd: config.OPENAI_TRANSCRIBE_COST_PER_MINUTE_USD,
          inputPer1MUsd: config.OPENAI_V2_INPUT_COST_PER_1M_TOKENS_USD,
          cachedInputPer1MUsd: config.OPENAI_V2_CACHED_INPUT_COST_PER_1M_TOKENS_USD,
          outputPer1MUsd: config.OPENAI_V2_OUTPUT_COST_PER_1M_TOKENS_USD,
        },
      })
    : null;
// Transcripción con Deepgram Nova-3 (si está elegida y su clave ya está en Secrets Manager); si no, Whisper.
const deepgramKey = config.DEEPGRAM_API_KEY?.trim();
const deepgram =
  config.TRANSCRIBE_PROVIDER === "deepgram" && looksLikeDeepgramKey(deepgramKey)
    ? new DeepgramTranscriber({ apiKey: deepgramKey, model: config.DEEPGRAM_MODEL, costPerMinuteUsd: config.DEEPGRAM_COST_PER_MINUTE_USD })
    : null;
const transcription = deepgram ? `deepgram ${config.DEEPGRAM_MODEL}` : config.TRANSCRIBE_PROVIDER === "deepgram" ? "whisper (falta la clave de Deepgram)" : "whisper";
const aiClassic = ai && deepgram ? withDeepgram(ai, deepgram) : ai;
const aiNew = aiV2 && deepgram ? withDeepgram(aiV2, deepgram) : aiV2;
const aiDisabledReason = config.AI_PROVIDER === "none" ? "IA desactivada por configuración" : "Falta la clave de OpenAI en Secrets Manager";


let stopping = false;
const stop = (signal: string) => {
  log.info({ signal }, "apagando worker (termina el mensaje actual si puede)");
  stopping = true;
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

log.info(
  {
    workerId,
    ai: ai ? "openai (gpt)" : `desactivada (${aiDisabledReason})`,
    transcription,
    // Solo si hay clave (nunca el valor).
    youtube: isApifyToken(config.APIFY_TOKEN) ? "apify" : "desactivado (falta la clave de Apify)",
    pipeline: config.AI_PIPELINE,
    v2Model: aiV2 ? config.OPENAI_V2_MODEL : null,
    sounds: config.SOUND_DETECTION_ENABLED,
    vision: config.AI_VISION_ENABLED,
    billing: config.BILLING_ENABLED,
    faces: config.FACE_TRACKING_ENABLED,
  },
  "worker iniciado",
);
try {
  await runConsumer({
    sqs: new SQSClient({ region: config.AWS_REGION }),
    queueUrl: config.SQS_QUEUE_URL,
    visibilitySeconds: config.SQS_VISIBILITY_SECONDS,
    shouldStop: () => stopping,
    idleExitSeconds: config.WORKER_IDLE_EXIT_SECONDS,
    deps: {
      db: database.db,
      storage: createS3WorkerStorage({ bucket: config.S3_BUCKET, region: config.AWS_REGION }),
      tools: { ffmpegPath: config.FFMPEG_PATH, ffprobePath: config.FFPROBE_PATH },
      product: loadProductConfig(),
      workDir: config.WORKER_TMP_DIR,
      workerId,
      costPerHourUsd: config.WORKER_COST_PER_HOUR_USD,
      ai: aiClassic,
      aiDisabledReason,
      aiV2: aiNew,
      defaultPipeline: config.AI_PIPELINE,
      frames: { minIntervalSeconds: config.AI_V2_FRAME_MIN_SECONDS, maxIntervalSeconds: config.AI_V2_FRAME_MAX_SECONDS },
      ...(config.SOUND_DETECTION_ENABLED ? {} : { detectSounds: false as const }),
      aiMaxAudioMinutes: config.OPENAI_MAX_AUDIO_MINUTES,
      faceTracking: config.FACE_TRACKING_ENABLED,
      billing: { enabled: config.BILLING_ENABLED, freeEmails: config.BILLING_FREE_EMAILS },
      ytDlpPath: config.YTDLP_PATH,
      apifyToken: config.APIFY_TOKEN?.trim(),
      vision: {
        enabled: config.AI_VISION_ENABLED,
        intervalSeconds: config.AI_VISION_INTERVAL_SECONDS,
        maxFrames: config.AI_VISION_MAX_FRAMES,
      },
      log: {
        info: (obj, msg) => log.info(obj, msg),
        warn: (obj, msg) => log.warn(obj, msg),
      },
    },
  });
} finally {
  await database.close();
  log.info("worker detenido");
}
