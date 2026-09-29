/**
 * Devuelve una ruta interna segura a la que redirigir tras el login.
 * Evita "open redirects": solo se aceptan rutas que empiezan por una sola "/".
 */
export function safeNextPath(value: string | null | undefined, fallback = "/dashboard"): string {
  if (!value) return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return fallback;
  return value;
}
