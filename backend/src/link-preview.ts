import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { LinkPreview } from "@clipflow/shared";

/**
 * Datos de un enlace (título, miniatura y duración) SIN bajar el video, para mostrar la tarjeta en
 * menos de 3 segundos. Solo se consulta a direcciones fijas de cada plataforma, armadas con el código
 * del video (nunca a la dirección que pegó el usuario tal cual): así no se puede usar para llegar a
 * servidores internos.
 * - Twitch: su API (GraphQL pública, la misma de la web), para videos guardados y clips.
 * - Kick: la página del video trae su registro (título, duración en segundos y miniatura).
 * - TikTok: oEmbed (título y miniatura; los videos son cortos y no informa la duración).
 * - Instagram y Facebook: piden sesión; se muestra la tarjeta sin datos.
 * Si algo falla o tarda, la tarjeta sale con lo que haya (nunca un error para el usuario).
 */
export interface PreviewOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const TWITCH_GQL = "https://gql.twitch.tv/gql";
/** Client-ID público de la web de Twitch (el mismo que usa el procesador para leer el chat). */
const TWITCH_WEB_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
/** Página de Kick: ~600 KB. Más que esto no se lee. */
const MAX_PAGE_BYTES = 3 * 1024 * 1024;

const hostIs = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

export function platformOf(url: URL): LinkPreview["platform"] | null {
  const host = url.hostname.toLowerCase();
  if (hostIs(host, "twitch.tv")) return "Twitch";
  if (hostIs(host, "kick.com")) return "Kick";
  if (hostIs(host, "tiktok.com")) return "TikTok";
  if (hostIs(host, "instagram.com")) return "Instagram";
  if (hostIs(host, "facebook.com") || hostIs(host, "fb.com") || hostIs(host, "fb.watch")) return "Facebook";
  return null;
}

/** Código de un video guardado (twitch.tv/videos/123) o de un clip (twitch.tv/canal/clip/x, clips.twitch.tv/x). */
export function twitchIds(url: URL): { videoId?: string; clipSlug?: string } {
  const video = url.pathname.match(/^\/videos\/(\d{1,20})\/?$/);
  if (video) return { videoId: video[1] };
  const host = url.hostname.toLowerCase();
  const clip = hostIs(host, "clips.twitch.tv")
    ? url.pathname.match(/^\/([\w-]{3,120})\/?$/)
    : url.pathname.match(/^\/[\w-]+\/clip\/([\w-]{3,120})\/?$/);
  return clip ? { clipSlug: clip[1] } : {};
}

/** Canal y código de un video guardado de Kick (kick.com/canal/videos/uuid). */
export function kickVideo(url: URL): { channel: string; id: string } | null {
  const m = url.pathname.match(/^\/([\w-]{1,60})\/videos\/([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\/?$/i);
  return m ? { channel: m[1]!, id: m[2]!.toLowerCase() } : null;
}

const httpsUrl = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  try {
    const u = new URL(value);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
};
const text = (value: unknown, max = 200): string | null =>
  typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim().slice(0, max) : null;
const seconds = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null);

async function twitchPreview(url: URL, get: typeof fetch, signal: AbortSignal): Promise<Partial<LinkPreview>> {
  const { videoId, clipSlug } = twitchIds(url);
  if (!videoId && !clipSlug) return {};
  const query = videoId
    ? `query($id:ID!){video(id:$id){title lengthSeconds previewThumbnailURL(width:640,height:360)}}`
    : `query($slug:ID!){clip(slug:$slug){title durationSeconds thumbnailURL}}`;
  const res = await get(TWITCH_GQL, {
    method: "POST",
    headers: { "Client-ID": TWITCH_WEB_CLIENT_ID, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: videoId ? { id: videoId } : { slug: clipSlug } }),
    signal,
  });
  if (!res.ok) return {};
  const data = ((await res.json()) as { data?: { video?: Record<string, unknown> | null; clip?: Record<string, unknown> | null } }).data;
  if (videoId) {
    const v = data?.video;
    return v ? { title: text(v.title), durationSeconds: seconds(v.lengthSeconds), thumbnailUrl: httpsUrl(v.previewThumbnailURL) } : {};
  }
  const c = data?.clip;
  return c ? { title: text(c.title), durationSeconds: seconds(c.durationSeconds), thumbnailUrl: httpsUrl(c.thumbnailURL) } : {};
}

/** El objeto JSON de la página de Kick que tiene "id": id y "recording_url" (como el complemento de yt-dlp). */
export function kickRecord(html: string, id: string): Record<string, unknown> | null {
  const page = html.replace(/\\"/g, '"').replace(/\\\//g, "/");
  const needle = `"id":"${id}"`;
  for (let at = page.indexOf(needle); at !== -1; at = page.indexOf(needle, at + 1)) {
    // Retrocede hasta la llave que abre este objeto y lo lee completo.
    let depth = 0;
    let start = -1;
    for (let i = at; i >= 0; i--) {
      const ch = page[i];
      if (ch === "}") depth++;
      else if (ch === "{") {
        if (depth === 0) {
          start = i;
          break;
        }
        depth--;
      }
    }
    if (start < 0) continue;
    const record = readJsonObject(page, start);
    if (record && "recording_url" in record) return record;
  }
  return null;
}

/** Lee el objeto JSON que empieza en `start` (llaves balanceadas, respetando las cadenas). */
function readJsonObject(page: string, start: number): Record<string, unknown> | null {
  let depth = 0;
  let inString = false;
  for (let i = start; i < page.length && i - start < 200_000; i++) {
    const ch = page[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try {
        const value = JSON.parse(page.slice(start, i + 1)) as unknown;
        return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function kickPreview(url: URL, get: typeof fetch, signal: AbortSignal): Promise<Partial<LinkPreview>> {
  const video = kickVideo(url);
  if (!video) return {};
  const res = await get(`https://kick.com/${encodeURIComponent(video.channel)}/videos/${video.id}`, {
    headers: { "User-Agent": BROWSER_UA, Accept: "text/html" },
    redirect: "error",
    signal,
  });
  if (!res.ok) return {};
  const record = kickRecord(await readCapped(res, MAX_PAGE_BYTES), video.id);
  if (!record) return {};
  const thumbnail = (record.thumbnail ?? null) as { src?: unknown } | null;
  return {
    title: text(record.title) ?? text(record.session_title),
    durationSeconds: seconds(record.duration),
    thumbnailUrl: httpsUrl(thumbnail?.src),
  };
}

async function tiktokPreview(url: URL, get: typeof fetch, signal: AbortSignal): Promise<Partial<LinkPreview>> {
  const res = await get(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url.toString())}`, { redirect: "error", signal });
  if (!res.ok) return {};
  const data = (await res.json()) as { title?: unknown; thumbnail_url?: unknown };
  return { title: text(data.title), thumbnailUrl: httpsUrl(data.thumbnail_url) };
}

/** Tarjeta del enlace (ya revisado con checkImportUrl). Nunca lanza: si falla, sin datos. */
export async function fetchLinkPreview(raw: string, options: PreviewOptions = {}): Promise<LinkPreview | null> {
  const url = new URL(raw);
  const platform = platformOf(url);
  if (!platform) return null;
  const get = options.fetch ?? fetch;
  const signal = AbortSignal.timeout(options.timeoutMs ?? 2500);
  let found: Partial<LinkPreview> = {};
  try {
    if (platform === "Twitch") found = await twitchPreview(url, get, signal);
    else if (platform === "Kick") found = await kickPreview(url, get, signal);
    else if (platform === "TikTok") found = await tiktokPreview(url, get, signal);
  } catch {
    found = {};
  }
  return {
    platform,
    title: found.title ?? null,
    thumbnailUrl: found.thumbnailUrl ?? null,
    durationSeconds: found.durationSeconds ?? null,
  };
}

/** Proxy de Evomi con país y sesión fijos (como el procesador). Otro proveedor: la URL tal cual. */
export function proxyWithSession(proxyUrl: string): string {
  const url = new URL(proxyUrl);
  if (url.hostname.endsWith("evomi.com") && url.password) {
    const password = decodeURIComponent(url.password);
    let extra = "";
    if (!password.includes("_country-")) extra += "_country-US";
    if (!password.includes("_session-")) extra += `_session-${randomBytes(6).toString("base64url").replace(/[^A-Za-z0-9]/g, "x").slice(0, 8)}_lifetime-60`;
    if (extra) url.password = `${url.password}${extra}`;
  }
  return url.toString();
}

/** El valor del secreto solo cuenta si es una URL de proxy (al crearlo tiene un relleno al azar). */
export function usableProxy(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim());
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname && url.port ? url.toString() : null;
  } catch {
    return null;
  }
}

export interface DetailsOptions {
  /** Python con yt-dlp y curl-cffi (en la imagen de la API: /opt/yt-dlp/bin/python). */
  python?: string;
  script?: string;
  proxyUrl?: string | null;
  timeoutMs?: number;
}

const LINK_META_SCRIPT = fileURLToPath(new URL("../link-meta/link_meta.py", import.meta.url));
/** Consultas a la vez (cada una es un proceso de Python de ~1–3 s). */
const MAX_RUNNING = 4;
let running = 0;

/**
 * Segundo paso de la tarjeta, cuando la consulta rápida no trajo la duración: lo mismo que lee el
 * procesador (Kick como un navegador real; las demás con yt-dlp, solo los datos) y, si bloquean, por el
 * proxy. ~1–3 s. Nunca lanza: si no se puede, devuelve null.
 */
export async function fetchLinkDetails(raw: string, options: DetailsOptions = {}): Promise<Partial<LinkPreview> | null> {
  const url = new URL(raw);
  if (!platformOf(url) || running >= MAX_RUNNING) return null;
  running++;
  try {
    const stdout = await new Promise<string>((resolve) => {
      const child = spawn(options.python ?? process.env.LINK_META_PYTHON ?? "/opt/yt-dlp/bin/python", ["-I", options.script ?? LINK_META_SCRIPT, url.toString()], {
        stdio: ["ignore", "pipe", "ignore"],
        // Solo lo necesario (nunca las claves de la API); el proxy va por variable, no en los argumentos.
        env: { PATH: process.env.PATH ?? "", HOME: "/tmp", ...(options.proxyUrl ? { CLIPFLOW_PROXY: proxyWithSession(options.proxyUrl) } : {}) },
      });
      let out = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 25_000);
      child.stdout.on("data", (c: Buffer) => (out = (out + c.toString()).slice(0, 20_000)));
      child.on("error", () => resolve(""));
      child.on("close", () => {
        clearTimeout(timer);
        resolve(out);
      });
    });
    const data = JSON.parse(stdout.trim() || "{}") as Record<string, unknown>;
    return {
      title: text(data.title),
      durationSeconds: seconds(data.durationSeconds),
      thumbnailUrl: httpsUrl(data.thumbnailUrl),
    };
  } catch {
    return null;
  } finally {
    running--;
  }
}
