/**
 * Proxy residencial pegado en Secrets Manager (`download-proxy`). Lo usan el procesador (descargas) y la
 * API (leer la duración de un enlace): los dos lo entienden igual.
 */

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
