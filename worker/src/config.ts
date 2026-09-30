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
  /** Tiempo que un mensaje queda oculto a otros workers; se renueva mientras se procesa. */
  SQS_VISIBILITY_SECONDS: z.coerce.number().int().min(60).max(43_200).default(300),
  /** Costo estimado por hora del worker (Fargate 2 vCPU / 4 GB x86 en us-east-1 ≈ 0.0987). */
  WORKER_COST_PER_HOUR_USD: z.coerce.number().nonnegative().default(0.0987),

  // --- IA (OpenAI) ---
  AI_PROVIDER: z.enum(["openai", "none"]).default("openai"),
  /** En AWS la inyecta ECS desde Secrets Manager. Nunca se registra en logs. */
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_TRANSCRIBE_MODEL: z.string().default("whisper-1"),
  OPENAI_ANALYSIS_MODEL: z.string().default("gpt-4o-mini"),
  OPENAI_MAX_AUDIO_MINUTES: z.coerce.number().positive().default(180),
  /** Precios para estimar costos (USD). Verificar en https://openai.com/api/pricing */
  OPENAI_TRANSCRIBE_COST_PER_MINUTE_USD: z.coerce.number().nonnegative().default(0.006),
  OPENAI_INPUT_COST_PER_1M_TOKENS_USD: z.coerce.number().nonnegative().default(0.15),
  OPENAI_OUTPUT_COST_PER_1M_TOKENS_USD: z.coerce.number().nonnegative().default(0.6),
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
