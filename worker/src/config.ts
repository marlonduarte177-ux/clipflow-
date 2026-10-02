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
  /** yt-dlp para importar videos por enlace (YouTube, TikTok…). */
  YTDLP_PATH: z.string().default("yt-dlp"),
  /**
   * Proxy residencial para plataformas que bloquean a AWS (YouTube…). Viene de Secrets Manager;
   * mientras tenga el valor de relleno (no es una URL), el proxy queda apagado.
   */
  DOWNLOAD_PROXY_URL: z.string().optional(),
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

/**
 * Normaliza el proxy pegado en Secrets Manager a `esquema://usuario:contraseña@host:puerto`.
 * Acepta también el formato que copia Evomi: `host:puerto:usuario:contraseña`, con o sin
 * `http://` delante. Devuelve null si está vacío, es el valor de relleno o no se entiende.
 */
export function parseProxyUrl(value: string | undefined): string | null {
  let v = value?.trim().replace(/^["']|["']$/g, "").trim();
  if (!v) return null;
  let scheme = "http";
  const schemeMatch = /^([a-z0-9]+):\/\//i.exec(v);
  if (schemeMatch) {
    scheme = schemeMatch[1]!.toLowerCase();
    v = v.slice(schemeMatch[0].length);
  }
  if (!["http", "https", "socks5", "socks5h"].includes(scheme)) return null;
  // host:puerto[:usuario:contraseña] (la contraseña puede llevar ":" o "@").
  if (/^[^:@/]+:\d{1,5}(:|$)/.test(v)) {
    const [host, port, user, ...rest] = v.split(":");
    if (!host || !port || !/^\d{1,5}$/.test(port)) return null;
    v = user && rest.length ? `${encodeURIComponent(user)}:${encodeURIComponent(rest.join(":"))}@${host}:${port}` : `${host}:${port}`;
  }
  try {
    const url = new URL(`${scheme}://${v}`);
    if (!url.hostname || !url.port) return null;
    return `${scheme}://${url.username ? `${url.username}:${url.password}@` : ""}${url.host}`;
  } catch {
    return null;
  }
}

/** Para el registro de arranque: qué hay en el secreto, sin mostrar su contenido. */
export function describeProxyValue(value: string | undefined): "activado" | "sin configurar" | "mal escrito" {
  if (parseProxyUrl(value)) return "activado";
  const v = value?.trim() ?? "";
  // Vacío o el valor de relleno que genera Secrets Manager (32 letras y números).
  return !v || /^[A-Za-z0-9]{32}$/.test(v) ? "sin configurar" : "mal escrito";
}
