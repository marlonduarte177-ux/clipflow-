/**
 * Tiempos escritos por el usuario: "1:30:00", "45:10", "90" (segundos) o "1h30m".
 * Devuelve los segundos, null si está vacío, o NaN si no se entiende.
 */
export function parseClock(text: string): number | null {
  const value = text.trim().toLowerCase().replace(/\s+/g, "");
  if (!value) return null;
  const units = /^(?:(\d+)h)?(?:(\d+)m(?:in)?)?(?:(\d+)s)?$/.exec(value);
  if (units && (units[1] || units[2] || units[3])) {
    return Number(units[1] ?? 0) * 3600 + Number(units[2] ?? 0) * 60 + Number(units[3] ?? 0);
  }
  const parts = value.split(":");
  if (parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return Number.NaN;
  const [s = 0, m = 0, h = 0] = parts.reverse().map(Number);
  if (parts.length > 1 && s >= 60) return Number.NaN;
  if (parts.length > 2 && m >= 60) return Number.NaN;
  return h * 3600 + m * 60 + s;
}
