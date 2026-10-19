import { z } from "zod";

/**
 * Variables de entorno de la API, validadas al arrancar.
 * Si falta algo obligatorio, la API no arranca y dice exactamente qué falta.
 */
const EnvSchema = z.object({
  AWS_REGION: z.string().default("us-east-1"),
  /** Local. En AWS se usan DB_HOST/DB_NAME/DB_USER/DB_PASSWORD (ver databaseUrlFromEnv). */
  DATABASE_URL: z.string().startsWith("postgres", "debe ser una URL postgres://").optional(),
  /** "true" en AWS (RDS exige TLS). */
  DATABASE_SSL: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  APP_ENV: z.enum(["development", "staging", "production"]).default("development"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default("http://localhost:3000")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  S3_BUCKET: z.string().min(3, "falta el nombre del bucket"),
  S3_UPLOAD_URL_EXPIRES_SECONDS: z.coerce.number().int().min(60).max(7 * 24 * 3600).default(3600),
  SQS_QUEUE_URL: z.url("debe ser la URL de la cola SQS"),
  // Encendido directo de procesadores (AWS). Vacío en local: no hace nada.
  WORKER_CLUSTER_ARN: z.string().optional(),
  WORKER_TASK_FAMILY: z.string().optional(),
  WORKER_SUBNETS: z.string().optional(),
  WORKER_SECURITY_GROUPS: z.string().optional(),
  WORKER_MAX_TASKS: z.coerce.number().int().positive().default(3),
  COGNITO_USER_POOL_ID: z.string().regex(/^[\w-]+_[0-9a-zA-Z]+$/, "formato esperado: us-east-1_XXXXXXX"),
  COGNITO_CLIENT_ID: z.string().min(1),

  // --- Pagos (Polar). Ver docs/pagos-polar.md ---
  /** "true" exige plan y minutos para crear clips. Mientras sea "false", se procesa sin plan. */
  BILLING_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Correos que no necesitan plan (p. ej. el del dueño), separados por coma. */
  BILLING_FREE_EMAILS: z.string().optional(),
  /** "sandbox" (pruebas, sin cobrar de verdad) o "production". */
  POLAR_SERVER: z.enum(["sandbox", "production"]).default("sandbox"),
  /** Productos mensuales de Polar (su ID, no es secreto). Básico lleva la prueba gratis de 7 días. */
  POLAR_PRODUCT_BASIC: z.string().optional(),
  POLAR_PRODUCT_PRO: z.string().optional(),
  POLAR_PRODUCT_MAX: z.string().optional(),
  /** Token de acceso de Polar (polar_oat_…). En AWS lo inyecta ECS desde Secrets Manager. */
  POLAR_ACCESS_TOKEN: z.string().optional(),
  /** Clave secreta de los avisos (webhooks) de Polar. En AWS la inyecta ECS desde Secrets Manager. */
  POLAR_WEBHOOK_SECRET: z.string().optional(),
  /** Nombres de esos dos secretos en Secrets Manager: la API los relee cada minuto (sin desplegar). */
  POLAR_ACCESS_TOKEN_SECRET_ID: z.string().optional(),
  POLAR_WEBHOOK_SECRET_ID: z.string().optional(),
});

export type ApiConfig = z.infer<typeof EnvSchema>;

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Configuración inválida de la API:\n${problems}`);
  }
  return result.data;
}
