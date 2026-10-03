import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { createWriteStream, existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { checkImportUrl, isImportPlatformUrl, isPrivateAddress } from "@clipflow/shared";

/**
 * Descarga de videos importados por enlace.
 * - TikTok, Instagram, Facebook, Kick y Twitch: yt-dlp. YouTube y otras plataformas por ahora no (las rechaza
 *   `checkImportUrl`: bloquean la descarga desde servidores).
 * - Cualquier otro enlace: debe ser un archivo de video directo. Se descarga con protección
 *   contra SSRF: en cada paso (también en redirecciones) se comprueba la IP REAL a la que se
 *   conecta, para no llegar nunca a direcciones internas (p. ej. las credenciales de ECS en
 *   169.254.170.2).
 */

/** Error de descarga con un mensaje apto para el usuario. */
export class DownloadError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    /** La plataforma bloqueó a nuestro servidor (vale la pena reintentar con el proxy). */
    readonly blocked = false,
    /** Detalle técnico para los registros (sin contraseñas); nunca se muestra al usuario. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = "DownloadError";
  }
}

/** true si el enlace es de una plataforma que se descarga con yt-dlp (TikTok, Instagram, Facebook, Kick, Twitch). */
export const isPlatformUrl = isImportPlatformUrl;

export interface DownloadOptions {
  ytDlpPath: string;
  ffmpegPath: string;
  maxBytes: number;
  maxDurationSeconds: number;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
  /** Solo para tests: hosts permitidos aunque sean locales. */
  allowHosts?: string[];
  /**
   * Proxy residencial (http://usuario:contraseña@host:puerto) para plataformas que bloquean a
   * los servidores de nube. Se usa solo cuando hace falta (ver `downloadWithYtDlp`).
   */
  proxyUrl?: string | null;
  /** Sin proxy: por qué ("mal escrito", "sin configurar"). Se agrega al mensaje si nos bloquean. */
  proxyProblem?: string | null;
  /**
   * "analysis": copia liviana (160p) de un stream largo, solo para elegir los momentos. Los clips se
   * generan después con tramos en 720p (`downloadSection`).
   */
  quality?: "analysis";
}

export interface Downloaded {
  file: string;
  sizeBytes: number;
  /** Título del video (si la plataforma lo da). */
  title: string | null;
}

/** Descarga el video del enlace dentro de `dir`. */
export async function downloadFromUrl(url: string, dir: string, options: DownloadOptions): Promise<Downloaded> {
  // También aquí: un enlace guardado antes de un cambio de reglas (p. ej. YouTube) se rechaza claro.
  const checked = checkImportUrl(url);
  if (!checked.ok && !options.allowHosts?.includes(new URL(url).hostname)) throw new DownloadError(checked.message, false);
  const result = isPlatformUrl(url) ? await downloadWithYtDlp(url, dir, options) : await downloadDirect(url, dir, options);
  const size = (await stat(result.file)).size;
  if (size === 0) throw new DownloadError("El enlace no devolvió ningún video.", false);
  if (size > options.maxBytes) throw new DownloadError("El video supera el tamaño máximo permitido.", false);
  return { ...result, sizeBytes: size };
}

// ---------------------------------------------------------------------------
// Plataformas (yt-dlp)
// ---------------------------------------------------------------------------

/** Traduce los errores de yt-dlp a mensajes claros. */
export function ytDlpErrorMessage(stderr: string): { message: string; retryable: boolean; blocked?: boolean } {
  const s = stderr.toLowerCase();
  // Fallos del propio proxy (credenciales, saldo agotado, caída): no son culpa del video.
  if (s.includes("proxy") || s.includes("tunnel") || s.includes("http error 407")) {
    const { reason, retryable } = proxyFailure(s);
    return { message: `Nuestro servicio de descarga no respondió (proxy: ${reason}). Lo intentaremos de nuevo.`, retryable };
  }
  // Twitch: videos solo para suscriptores del canal. Un proxy no lo arregla.
  if (s.includes("subscriber-only")) {
    return { message: "Este video es solo para suscriptores del canal, así que no se puede importar.", retryable: false };
  }
  // Restricción de edad: la plataforma exige una cuenta; un proxy no lo arregla.
  if (s.includes("confirm your age") || s.includes("age-restricted") || s.includes("inappropriate for some users")) {
    return {
      message: "Este video tiene restricción de edad y la plataforma pide iniciar sesión para verlo. Descárgalo y súbelo como archivo.",
      retryable: false,
    };
  }
  // Bloqueo por país (el del servidor o el del proxy): por el proxy se intenta desde EE. UU.
  if (s.includes("in your country") || s.includes("geo restrict") || s.includes("geo-restrict")) {
    return {
      message: "Este video no está disponible desde el país de nuestros servidores. Descárgalo y súbelo como archivo.",
      retryable: false,
      blocked: true,
    };
  }
  // "This content isn't available, try again later": así responden a IPs que marcaron.
  if (s.includes("content isn't available") || s.includes("content isn\u2019t available") || s.includes("try again later")) {
    return {
      message: "La plataforma bloqueó la descarga desde nuestros servidores. Descarga el video y súbelo como archivo.",
      retryable: false,
      blocked: true,
    };
  }
  if ((s.includes("confirm you") && s.includes("bot")) || s.includes("http error 403")) {
    return {
      message: "La plataforma bloqueó la descarga desde nuestros servidores. Descarga el video y súbelo como archivo.",
      retryable: false,
      blocked: true,
    };
  }
  if (
    s.includes("private video") ||
    s.includes("sign in") ||
    s.includes("login required") ||
    s.includes("log in") ||
    s.includes("logged-in") ||
    s.includes("logged in")
  ) {
    // Instagram y Facebook piden "iniciar sesión" a los servidores de nube aunque el video sea
    // público: con el proxy se reintenta (si de verdad es privado, falla igual y casi sin costo).
    return { message: "Este video es privado o pide iniciar sesión, así que no se puede descargar.", retryable: false, blocked: true };
  }
  // Enlace de un canal (p. ej. kick.com/canal) que no está transmitiendo: no hay un video que bajar.
  if (s.includes("not currently live")) {
    return { message: "Ese enlace es de un canal, no de un video. Pega el enlace de un clip o de un video guardado.", retryable: false };
  }
  // yt-dlp no dice cuál de los dos filtros falló (duración o en vivo).
  if (s.includes("does not pass filter")) {
    return { message: "El video supera la duración máxima permitida o es una transmisión en vivo.", retryable: false };
  }
  if (s.includes("larger than max-filesize") || s.includes("max-filesize")) {
    return { message: "El video supera el tamaño máximo permitido.", retryable: false };
  }
  if (s.includes("is live") || s.includes("live event")) return { message: "No se pueden importar transmisiones en vivo.", retryable: false };
  if (
    s.includes("unsupported url") ||
    s.includes("no video formats") ||
    s.includes("unavailable") ||
    s.includes("http error 404") ||
    s.includes("does not exist") ||
    s.includes("not found")
  ) {
    return { message: "No encontramos un video en ese enlace (puede que se haya borrado).", retryable: false };
  }
  if (s.includes("unexpected response from webpage") || s.includes("ip address is blocked") || s.includes("impersonat")) {
    return {
      message: "La plataforma no permitió descargar este video desde nuestros servidores. Descárgalo y súbelo como archivo.",
      retryable: false,
      blocked: true,
    };
  }
  if (s.includes("http error 429") || s.includes("rate-limit") || s.includes("rate limit")) {
    return { message: "La plataforma no respondió. Lo intentaremos de nuevo.", retryable: true, blocked: true };
  }
  if (s.includes("timed out") || s.includes("connection") || s.includes("http error 5")) {
    return { message: "La plataforma no respondió. Lo intentaremos de nuevo.", retryable: true };
  }
  return { message: "No pudimos descargar el video de ese enlace.", retryable: false };
}

/**
 * Motivo corto de un fallo del proxy, para verlo en la app sin entrar a CloudWatch. Credenciales,
 * saldo o un sitio bloqueado por el proveedor no se arreglan reintentando.
 */
function proxyFailure(s: string): { reason: string; retryable: boolean } {
  const status = /(?:tunnel connection failed:?|tunnel failed, response|response|http error)\s*(\d{3})/.exec(s)?.[1] ?? /\b(40[2378])\b/.exec(s)?.[1];
  if (status === "407") return { reason: "usuario o contraseña incorrectos, 407", retryable: false };
  if (status === "402") return { reason: "sin saldo, 402", retryable: false };
  if (status === "403") return { reason: "el proveedor no permite este sitio, 403", retryable: false };
  if (status) return { reason: `error ${status}`, retryable: true };
  if (s.includes("resolve")) return { reason: "no se encontró el servidor del proxy", retryable: false };
  if (s.includes("timed out") || s.includes("timeout")) return { reason: "tiempo de espera agotado", retryable: true };
  return { reason: "no se pudo conectar", retryable: true };
}

/**
 * Descarga con yt-dlp. Primero sin proxy (gratis: TikTok funciona así). Si la plataforma nos
 * bloquea y hay proxy configurado, se reintenta una vez por el proxy, hasta 720p (se paga por GB y
 * para clips verticales sobra).
 */
export async function downloadWithYtDlp(url: string, dir: string, options: DownloadOptions): Promise<Omit<Downloaded, "sizeBytes">> {
  const proxy = options.proxyUrl ? withStickySession(options.proxyUrl) : null;
  try {
    return await runYtDlp(url, dir, options, null);
  } catch (err) {
    if (!(err instanceof DownloadError) || !err.blocked) throw err;
    if (!proxy) {
      // Bloqueado y sin proxy utilizable: se dice por qué, para no tener que buscarlo en CloudWatch.
      if (options.proxyProblem) throw new DownloadError(`${err.message} (proxy: ${options.proxyProblem})`, err.retryable, true, err.detail);
      throw err;
    }
    for (const leftover of (await readdir(dir)).filter((f) => f.startsWith("source."))) {
      await rm(path.join(dir, leftover), { force: true });
    }
    return runYtDlp(url, dir, options, proxy);
  }
}

// ---------------------------------------------------------------------------
// Streams largos: datos del enlace y tramos de video
// ---------------------------------------------------------------------------

export interface MediaInfo {
  title: string | null;
  durationSeconds: number | null;
  isLive: boolean;
}

/** Corre yt-dlp sin descargar y devuelve lo que imprime (con el mismo respaldo por proxy). */
async function ytDlpQuery(url: string, options: DownloadOptions, extraArgs: string[]): Promise<{ stdout: string; proxy: string | null }> {
  const run = (proxy: string | null) =>
    new Promise<{ stdout: string; proxy: string | null }>((resolve, reject) => {
      const args = [
        "--no-playlist",
        "--no-warnings",
        "--no-cache-dir",
        ...(existsSync(YTDLP_PLUGINS_DIR) ? ["--plugin-dirs", YTDLP_PLUGINS_DIR] : []),
        "--socket-timeout",
        "30",
        ...(proxy ? ["--proxy", proxy] : []),
        ...extraArgs,
        "--",
        url,
      ];
      const child = spawn(options.ytDlpPath, args, { stdio: ["ignore", "pipe", "pipe"] });
      const onAbort = () => child.kill("SIGKILL");
      options.signal?.addEventListener("abort", onAbort, { once: true });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
      child.stderr.on("data", (c: Buffer) => (stderr = (stderr + c.toString()).slice(-4000)));
      child.on("error", (err) => reject(new DownloadError(`No se pudo iniciar la descarga (${err.message}).`, true)));
      child.on("close", (code) => {
        options.signal?.removeEventListener("abort", onAbort);
        if (options.signal?.aborted) return reject(new DOMException("Cancelado", "AbortError"));
        if (code === 0) return resolve({ stdout, proxy });
        const mapped = ytDlpErrorMessage(stderr);
        const lastLine = redactCredentials(stderr.trim().split("\n").pop() ?? "").slice(0, 300);
        reject(new DownloadError(mapped.message, mapped.retryable, mapped.blocked ?? false, `${proxy ? "[proxy] " : ""}${lastLine}`));
      });
    });
  const proxy = options.proxyUrl ? withStickySession(options.proxyUrl) : null;
  try {
    return await run(null);
  } catch (err) {
    if (!(err instanceof DownloadError) || !err.blocked || !proxy) throw err;
    return run(proxy);
  }
}

/** Título, duración y si está en vivo, sin descargar nada (para decidir cómo procesar). */
export async function fetchMediaInfo(url: string, options: DownloadOptions): Promise<MediaInfo> {
  const { stdout } = await ytDlpQuery(url, options, ["--skip-download", "--dump-single-json"]);
  try {
    const data = JSON.parse(stdout) as { title?: string; duration?: number; is_live?: boolean };
    return {
      title: typeof data.title === "string" ? data.title : null,
      durationSeconds: typeof data.duration === "number" && data.duration > 0 ? data.duration : null,
      isLive: data.is_live === true,
    };
  } catch {
    throw new DownloadError("No pudimos leer los datos de ese enlace.", true);
  }
}

/** Fuente de los tramos de un stream: las URLs del video en 720p (HLS) y el proxy, si hizo falta. */
export interface StreamSource {
  urls: string[];
  proxy: string | null;
}

/** Las direcciones directas del video en 720p (una con audio y video, o una de cada). */
export async function resolveStreamUrls(url: string, options: DownloadOptions): Promise<StreamSource> {
  const { stdout, proxy } = await ytDlpQuery(url, options, ["-f", "bv*+ba/b", "-S", "res:720,vcodec:h264,acodec:aac", "--get-url"]);
  const urls = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^https?:\/\//.test(l));
  if (urls.length === 0 || urls.length > 2) throw new DownloadError("No pudimos leer los datos de ese enlace.", true);
  return { urls, proxy };
}

/**
 * Baja SOLO un tramo del video (p. ej. un clip de 60 s de un stream de 3 h), con corte exacto:
 * FFmpeg busca el segundo pedido y vuelve a codificar (sin eso, el tramo empezaría en el fotograma
 * clave anterior y los subtítulos quedarían corridos). Probado: desfase de ~0,04 s.
 */
export async function downloadSection(
  source: StreamSource,
  startSeconds: number,
  durationSeconds: number,
  output: string,
  options: { ffmpegPath: string; signal?: AbortSignal },
): Promise<void> {
  const inputs = source.urls.flatMap((u) => [
    "-ss",
    startSeconds.toFixed(3),
    ...(source.proxy && /^https?:/.test(u) ? ["-http_proxy", source.proxy] : []),
    "-i",
    u,
  ]);
  const maps = source.urls.length === 2 ? ["-map", "0:v:0", "-map", "1:a:0"] : ["-map", "0:v:0", "-map", "0:a:0?"];
  const args = [
    "-hide_banner",
    "-nostats",
    "-loglevel",
    "error",
    "-y",
    ...inputs,
    ...maps,
    "-t",
    durationSeconds.toFixed(3),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-movflags",
    "+faststart",
    output,
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(options.ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    const onAbort = () => child.kill("SIGKILL");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => (stderr = (stderr + c.toString()).slice(-2000)));
    child.on("error", (err) => reject(new DownloadError(`No se pudo bajar un tramo del video (${err.message}).`, true)));
    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", onAbort);
      if (options.signal?.aborted) return reject(new DOMException("Cancelado", "AbortError"));
      if (code === 0 && existsSync(output)) return resolve();
      const detail = redactCredentials(stderr.trim().split("\n").pop() ?? "").slice(0, 300);
      reject(new DownloadError("No pudimos bajar un tramo del video. Lo intentaremos de nuevo.", true, false, detail));
    });
  });
}

/**
 * Opciones de Evomi, que van agregadas a la contraseña:
 * - **País fijo** (`_country-US`, salvo que la contraseña ya traiga uno). Con "Mundial", cada
 *   descarga salía de un país al azar y algunos videos volvían "no disponible en tu país".
 * - **Misma IP durante toda la descarga** (`_session-<8 caracteres>`, 60 min): las plataformas
 *   atan el enlace del video a la IP que lo pidió; un proxy que rota la IP en cada petición lo rompería.
 * Otros proveedores: pegar la URL ya con su país y su sesión fija.
 */
export function withStickySession(proxyUrl: string): string {
  const url = new URL(proxyUrl);
  if (url.hostname.endsWith("evomi.com") && url.password) {
    const password = decodeURIComponent(url.password);
    let extra = "";
    if (!password.includes("_country-")) extra += "_country-US";
    if (!password.includes("_session-")) {
      const session = randomBytes(6).toString("base64url").replace(/[^A-Za-z0-9]/g, "x").slice(0, 8);
      extra += `_session-${session}_lifetime-60`;
    }
    if (extra) url.password = `${url.password}${extra}`;
  }
  return url.toString();
}

/** Quita usuarios y contraseñas de cualquier URL dentro de un texto (para los registros). */
export function redactCredentials(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@");
}

async function runYtDlp(url: string, dir: string, options: DownloadOptions, proxy: string | null): Promise<Omit<Downloaded, "sizeBytes">> {
  const args = [
    "--no-playlist",
    "--no-warnings",
    "--no-cache-dir",
    // Complementos propios de yt-dlp (p. ej. Kick con los códigos de video nuevos).
    ...(existsSync(YTDLP_PLUGINS_DIR) ? ["--plugin-dirs", YTDLP_PLUGINS_DIR] : []),
    "--newline",
    "--no-simulate",
    // --print deja a yt-dlp en modo silencioso: esto vuelve a mostrar el avance.
    "--progress",
    // Ruta COMPLETA: con un nombre suelto ("ffmpeg"), yt-dlp lo busca en la carpeta actual, no lo
    // encuentra y sigue SIN FFmpeg (el aviso lo oculta --no-warnings). Sin FFmpeg no puede unir video
    // y audio separados (Instagram, Facebook) y el archivo final nunca existía (error ENOENT).
    ...ffmpegLocationArgs(options.ffmpegPath),
    // Hasta 1080p, prefiriendo H.264/AAC (más rápido de procesar); todo en un .mp4.
    "-f",
    "bv*+ba/b",
    "-S",
    // Hasta 720p por el proxy (se paga por GB) y en Kick y Twitch: sus videos guardados duran horas y
    // en 1080p60 pesan ~2,8 GB por hora (en 720p, la mitad; para clips verticales alcanza).
    options.quality === "analysis"
      ? "res:160,+size,acodec:aac"
      : proxy || isStreamPlatformUrl(url)
        ? "res:720,vcodec:h264,acodec:aac"
        : "res:1080,vcodec:h264,acodec:aac",
    ...(proxy ? ["--proxy", proxy] : []),
    "--merge-output-format",
    "mp4",
    "--match-filters",
    `duration <=? ${Math.floor(options.maxDurationSeconds)} & !is_live`,
    "--max-filesize",
    String(options.maxBytes),
    "--socket-timeout",
    "30",
    "--retries",
    "3",
    "--progress-template",
    "download:PROGRESS %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s",
    "--print",
    "before_dl:TITLE %(title)s",
    "--print",
    "after_move:FILE %(filepath)s",
    "-o",
    path.join(dir, "source.%(ext)s"),
    "--",
    url,
  ];
  let title: string | null = null;
  let file: string | null = null;
  let stderr = "";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(options.ytDlpPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    const onAbort = () => child.kill("SIGKILL");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("TITLE ")) title = line.slice(6).trim() || null;
        else if (line.startsWith("FILE ")) file = line.slice(5).trim();
        else if (line.startsWith("PROGRESS ")) {
          const [done, total, estimate] = line.slice(9).split(" ").map(Number);
          const all = Number.isFinite(total) && total! > 0 ? total! : estimate!;
          if (Number.isFinite(done) && Number.isFinite(all) && all > 0) options.onProgress?.(Math.min(1, done! / all));
        }
      }
    });
    child.stderr.on("data", (c: Buffer) => (stderr = (stderr + c.toString()).slice(-4000)));
    child.on("error", (err) => reject(new DownloadError(`No se pudo iniciar la descarga (${err.message}).`, true)));
    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", onAbort);
      if (options.signal?.aborted) return reject(new DOMException("Cancelado", "AbortError"));
      if (code === 0) return resolve();
      const mapped = ytDlpErrorMessage(stderr);
      const lastLine = redactCredentials(stderr.trim().split("\n").pop() ?? "").slice(0, 300);
      reject(new DownloadError(mapped.message, mapped.retryable, mapped.blocked ?? false, `${proxy ? "[proxy] " : ""}${lastLine}`));
    });
  });
  // El archivo anunciado puede no existir (p. ej. no se pudieron unir video y audio): se usa lo que
  // haya quedado. yt-dlp tampoco descarga nada si el video no pasa los filtros (duración, en vivo).
  if (!file || !existsSync(file)) {
    const leftovers = (await readdir(dir)).filter((f) => f.startsWith("source.") && !/\.(part|ytdl|temp)$/.test(f));
    if (leftovers.length === 0) {
      if (file) throw new DownloadError("No pudimos descargar el video de ese enlace. Lo intentaremos de nuevo.", true, false, "falta el archivo final");
      throw new DownloadError(ytDlpErrorMessage(stderr || "does not pass filter").message, false);
    }
    // Varios archivos = video y audio sin unir: no sirve uno solo (quedaría sin sonido o sin imagen).
    if (leftovers.length > 1) {
      throw new DownloadError("No pudimos unir el video y el audio de ese enlace. Lo intentaremos de nuevo.", true, false, `sin unir: ${leftovers.join(", ")}`);
    }
    file = path.join(dir, leftovers[0]!);
  }
  return { file, title };
}

/**
 * Complementos propios de yt-dlp (ver `worker/ytdlp-plugins`). Hoy: Kick con los códigos de video
 * nuevos (UUIDv7), que la API que usa yt-dlp ya no reconoce.
 */
export const YTDLP_PLUGINS_DIR = fileURLToPath(new URL("../ytdlp-plugins/", import.meta.url));

/** Kick y Twitch: plataformas de streams (videos guardados de horas). */
export const isStreamPlatformUrl = (url: string) => /(^|\.)(kick\.com|twitch\.tv)$/i.test(new URL(url).hostname);

/** `--ffmpeg-location` con ruta completa (buscada en el PATH si viene solo el nombre); si no está, nada. */
export function ffmpegLocationArgs(ffmpegPath: string): string[] {
  if (path.isAbsolute(ffmpegPath)) return ["--ffmpeg-location", ffmpegPath];
  for (const folder of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(folder, ffmpegPath);
    if (existsSync(candidate)) return ["--ffmpeg-location", candidate];
  }
  // Sin la opción, yt-dlp busca "ffmpeg" en el PATH por su cuenta.
  return [];
}

// ---------------------------------------------------------------------------
// Enlaces directos a un archivo (con protección SSRF)
// ---------------------------------------------------------------------------

const MAX_REDIRECTS = 5;
const VIDEO_EXTENSIONS: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
};

/** Resolución DNS que rechaza direcciones internas (se usa al CONECTAR: sin carreras con el DNS). */
function guardedLookup(allowHosts: string[]) {
  return (
    hostname: string,
    options: { all?: boolean; family?: number },
    callback: (err: Error | null, address: string | LookupAddress[], family?: number) => void,
  ) => {
    dnsLookup(hostname, { family: options.family ?? 0, all: true }, (err, addresses) => {
      if (err) return callback(err, "");
      const list = addresses as LookupAddress[];
      if (!allowHosts.includes(hostname) && (list.length === 0 || list.some((a) => isPrivateAddress(a.address)))) {
        return callback(new DownloadError("Ese enlace apunta a una dirección privada.", false), "");
      }
      if (options.all) callback(null, list);
      else callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

function request(url: URL, options: DownloadOptions): Promise<IncomingMessage> {
  const allowHosts = options.allowHosts ?? [];
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // Con una IP escrita en el enlace, Node no consulta el DNS: se revisa aquí.
  if (isIP(host) && isPrivateAddress(host) && !allowHosts.includes(host)) {
    return Promise.reject(new DownloadError("Ese enlace apunta a una dirección privada.", false));
  }
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.get(
      url,
      {
        lookup: guardedLookup(allowHosts) as never,
        headers: { "user-agent": "ClipFlow/1.0 (+importar video)", accept: "video/*,*/*;q=0.5" },
        signal: options.signal,
        timeout: 60_000,
      },
      resolve,
    );
    req.on("timeout", () => req.destroy(new DownloadError("El servidor del enlace no respondió.", true)));
    req.on("error", (err) =>
      reject(err instanceof DownloadError || (err as Error).name === "AbortError" ? err : new DownloadError("No se pudo conectar con el enlace.", true)),
    );
  });
}

async function downloadDirect(raw: string, dir: string, options: DownloadOptions): Promise<Omit<Downloaded, "sizeBytes">> {
  let url = new URL(raw);
  for (let hop = 0; ; hop++) {
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new DownloadError("El enlace redirige a un lugar no permitido.", false);
    const res = await request(url, options);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      if (hop >= MAX_REDIRECTS) throw new DownloadError("El enlace redirige demasiadas veces.", false);
      url = new URL(res.headers.location, url);
      continue;
    }
    if (status !== 200) {
      res.resume();
      throw new DownloadError(
        status === 404 ? "No encontramos un video en ese enlace." : `El enlace respondió con un error (${status}).`,
        status >= 500 || status === 429,
      );
    }
    const type = String(res.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (type.startsWith("text/") || type.includes("html") || type.includes("json")) {
      res.resume();
      throw new DownloadError(
        "El enlace no es un archivo de video. Si es de una red social, usa el enlace de la publicación; si es de otra página, sube el video como archivo.",
        false,
      );
    }
    const length = Number(res.headers["content-length"]);
    if (Number.isFinite(length) && length > options.maxBytes) {
      res.resume();
      throw new DownloadError("El video supera el tamaño máximo permitido.", false);
    }
    const ext = VIDEO_EXTENSIONS[type] ?? (path.extname(url.pathname).slice(1).toLowerCase().match(/^(mp4|mov|webm|mkv|m4v)$/)?.[0] ?? "mp4");
    const file = path.join(dir, `source.${ext}`);
    let received = 0;
    res.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > options.maxBytes) res.destroy(new DownloadError("El video supera el tamaño máximo permitido.", false));
      else if (Number.isFinite(length) && length > 0) options.onProgress?.(received / length);
    });
    try {
      await pipeline(res, createWriteStream(file));
    } catch (err) {
      await rm(file, { force: true });
      if (err instanceof DownloadError || (err as Error).name === "AbortError") throw err;
      throw new DownloadError("La descarga se cortó. Lo intentaremos de nuevo.", true);
    }
    return { file, title: null };
  }
}
