import os from "node:os";
import { SQSClient } from "@aws-sdk/client-sqs";
import pino from "pino";
import { loadProductConfig } from "@clipflow/shared";
import { createDb, databaseUrlFromEnv } from "@clipflow/shared/db";
import { OpenAIProvider } from "./ai/openai.js";
import { describeProxyValue, loadWorkerConfig, looksLikeOpenAIKey, parseProxyUrl } from "./config.js";
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
          outputPer1MUsd: config.OPENAI_OUTPUT_COST_PER_1M_TOKENS_USD,
        },
      })
    : null;
const aiDisabledReason = config.AI_PROVIDER === "none" ? "IA desactivada por configuración" : "Falta la clave de OpenAI en Secrets Manager";

const downloadProxyUrl = parseProxyUrl(config.DOWNLOAD_PROXY_URL);

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
    ai: ai ? "openai (whisper + gpt)" : `desactivada (${aiDisabledReason})`,
    vision: config.AI_VISION_ENABLED,
    faces: config.FACE_TRACKING_ENABLED,
    // Solo el host del proxy: nunca el usuario ni la contraseña.
    downloadProxy: downloadProxyUrl ? new URL(downloadProxyUrl).hostname : describeProxyValue(config.DOWNLOAD_PROXY_URL),
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
      ai,
      aiDisabledReason,
      aiMaxAudioMinutes: config.OPENAI_MAX_AUDIO_MINUTES,
      faceTracking: config.FACE_TRACKING_ENABLED,
      ytDlpPath: config.YTDLP_PATH,
      downloadProxyUrl,
      downloadProxyProblem: downloadProxyUrl ? null : describeProxyValue(config.DOWNLOAD_PROXY_URL),
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
