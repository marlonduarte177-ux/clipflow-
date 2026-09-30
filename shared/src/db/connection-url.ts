/**
 * URL de conexión a PostgreSQL a partir del entorno.
 * - Local: DATABASE_URL (ver .env.example).
 * - AWS: ECS entrega DB_HOST, DB_PORT, DB_NAME y, desde Secrets Manager, DB_USER y DB_PASSWORD.
 *   Así la contraseña nunca aparece en el código ni en la configuración visible.
 */
export function databaseUrlFromEnv(env: Record<string, string | undefined> = process.env): string {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  const { DB_HOST, DB_PORT = "5432", DB_NAME, DB_USER, DB_PASSWORD } = env;
  if (!DB_HOST || !DB_NAME || !DB_USER || !DB_PASSWORD) {
    throw new Error("Falta DATABASE_URL o el conjunto DB_HOST, DB_NAME, DB_USER, DB_PASSWORD");
  }
  const url = new URL(`postgres://${DB_HOST}:${DB_PORT}/${DB_NAME}`);
  url.username = DB_USER;
  url.password = DB_PASSWORD; // URL se encarga de escapar caracteres especiales
  return url.toString();
}
