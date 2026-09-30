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
