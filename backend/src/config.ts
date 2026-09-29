import { z } from "zod";

/**
 * Variables de entorno de la API, validadas al arrancar.
 * Si falta algo obligatorio, la API no arranca y dice exactamente qué falta.
 */
const EnvSchema = z.object({
  AWS_REGION: z.string().default("us-east-1"),
  DATABASE_URL: z.string().startsWith("postgres", "debe ser una URL postgres://"),
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
  COGNITO_USER_POOL_ID: z.string().regex(/^[\w-]+_[0-9a-zA-Z]+$/, "formato esperado: us-east-1_XXXXXXX"),
  COGNITO_CLIENT_ID: z.string().min(1),
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
