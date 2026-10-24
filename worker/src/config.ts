import { z } from "zod";

const EnvSchema = z.object({
  APP_ENV: z.enum(["development", "staging", "production"]).default("development"),
  AWS_REGION: z.string().default("us-east-1"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  SQS_QUEUE_URL: z.url("debe ser la URL de la cola SQS"),
  S3_BUCKET: z.string().min(3),
  DATABASE_SSL: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  WORKER_TMP_DIR: z.string().default("/tmp/clipflow"),
  FFMPEG_PATH: z.string().default("ffmpeg"),
  FFPROBE_PATH: z.string().default("ffprobe"),
  /** yt-dlp para importar videos por enlace (TikTok, Instagram, Facebook, Kick). */
  YTDLP_PATH: z.string().default("yt-dlp"),
  /** Clave de Apify para importar YouTube (solo administradores). En AWS la inyecta ECS; nunca se registra. */
  APIFY_TOKEN: z.string().optional(),
  /** Tiempo que un mensaje queda oculto a otros workers; se renueva mientras se procesa. */
  SQS_VISIBILITY_SECONDS: z.coerce.number().int().min(60).max(43_200).default(300),
  /** Costo estimado por hora del worker (Fargate 4 vCPU / 8 GB x86 en us-east-1 ≈ 0.1975). */
  /** 0 = no se apaga solo (lo maneja el escalado). Los workers que enciende la API usan 600. */
  WORKER_IDLE_EXIT_SECONDS: z.coerce.number().int().nonnegative().default(0),
  WORKER_COST_PER_HOUR_USD: z.coerce.number().nonnegative().default(0.1975),

  // --- IA (OpenAI) ---
  AI_PROVIDER: z.enum(["openai", "none"]).default("openai"),
  /** En AWS la inyecta ECS desde Secrets Manager. Nunca se registra en logs. */
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_TRANSCRIBE_MODEL: z.string().default("whisper-1"),
  /** Quién transcribe: "deepgram" (Nova-3) u "openai" (Whisper). Sin clave de Deepgram, Whisper. */
  TRANSCRIBE_PROVIDER: z.enum(["openai", "deepgram"]).default("openai"),
  /** En AWS la inyecta ECS desde Secrets Manager. Nunca se registra en logs. */
  DEEPGRAM_API_KEY: z.string().optional(),
  DEEPGRAM_MODEL: z.string().default("nova-3"),
  /** Nova-3, audio grabado: 0,0043 USD por minuto (octubre de 2026). */
  DEEPGRAM_COST_PER_MINUTE_USD: z.coerce.number().nonnegative().default(0.0043),
  OPENAI_ANALYSIS_MODEL: z.string().default("gpt-4o-mini"),
  OPENAI_MAX_AUDIO_MINUTES: z.coerce.number().positive().default(180),
  /** Encuadre que sigue caras (detector local, sin costo por imagen). "false" lo apaga. */
  FACE_TRACKING_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /** Análisis de imágenes con IA (experimental: cuesta por imagen). */
  AI_VISION_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  AI_VISION_INTERVAL_SECONDS: z.coerce.number().min(1).default(3),
  /** Tope de fotogramas por video (control de costos). */
  AI_VISION_MAX_FRAMES: z.coerce.number().int().positive().default(600),
  /** Modelo con visión; vacío = el mismo del análisis (usa sus precios). */
  OPENAI_VISION_MODEL: z.string().optional(),
  /** Precios para estimar costos (USD). Verificar en https://openai.com/api/pricing */
  OPENAI_TRANSCRIBE_COST_PER_MINUTE_USD: z.coerce.number().nonnegative().default(0.006),
  OPENAI_INPUT_COST_PER_1M_TOKENS_USD: z.coerce.number().nonnegative().default(0.15),
  OPENAI_CACHED_INPUT_COST_PER_1M_TOKENS_USD: z.coerce.number().nonnegative().default(0.075),
  OPENAI_OUTPUT_COST_PER_1M_TOKENS_USD: z.coerce.number().nonnegative().default(0.6),

  // --- Versión nueva del análisis ("v2"): modelo de gama alta + sonidos + fotogramas ---
  /** Versión que usan los videos de los usuarios: "classic" (actual) o "v2". La prueba lado a lado usa las dos. */
  AI_PIPELINE: z.enum(["classic", "v2"]).default("classic"),
  /** GPT-6.1 Sol: casi tan bueno como el más caro, por 1/5 del precio (octubre de 2026). */
  OPENAI_V2_MODEL: z.string().default("gpt-6.1-sol"),
  /** Cuánto piensa el modelo: "low", "medium" (por defecto del modelo) o "high". */
  OPENAI_V2_REASONING_EFFORT: z.enum(["low", "medium", "high"]).default("medium"),
  OPENAI_V2_INPUT_COST_PER_1M_TOKENS_USD: z.coerce.number().nonnegative().default(2),
  OPENAI_V2_CACHED_INPUT_COST_PER_1M_TOKENS_USD: z.coerce.number().nonnegative().default(0.1),
  OPENAI_V2_OUTPUT_COST_PER_1M_TOKENS_USD: z.coerce.number().nonnegative().default(10),
  /** Un fotograma cada 5 s (videos cortos) hasta cada 10 s (desde 1 h). */
  AI_V2_FRAME_MIN_SECONDS: z.coerce.number().min(1).default(5),
  AI_V2_FRAME_MAX_SECONDS: z.coerce.number().min(1).default(10),
  /** Detector de risas, gritos, aplausos y vítores (local, sin costo). "false" lo apaga. */
  SOUND_DETECTION_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),


  // --- Pagos: con "true", cada video descuenta sus minutos del plan (ver docs/pagos-polar.md) ---
  BILLING_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Correos que no necesitan plan, separados por coma. */
  BILLING_FREE_EMAILS: z.string().optional(),
});

export type WorkerConfig = z.infer<typeof EnvSchema>;

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Configuración inválida del worker:\n${problems}`);
  }
  return result.data;
}

/** Una clave de OpenAI tiene el formato "sk-...". El valor inicial del secreto en AWS no lo tiene. */
export function looksLikeOpenAIKey(value: string | undefined): value is string {
  return typeof value === "string" && /^sk-[A-Za-z0-9_-]{20,}$/.test(value.trim());
}

