/**
 * Chat de los VODs de Twitch como señal de interés.
 *
 * Twitch guarda el chat del directo junto al VOD. Lo leemos con la misma API pública que usa
 * su reproductor web (GraphQL, sin cuenta ni claves nuestras) y medimos la actividad cada
 * pocos segundos: mensajes por segundo, emotes y risas, cheers (bits) y los avisos de subs o
 * donaciones que publican los bots del canal. Donde el chat explota suele haber un buen clip.
 *
 * Nunca hace fallar el procesamiento: si el chat no está disponible, se devuelve null y los
 * momentos se eligen con las demás señales.
 */

const GQL_URL = "https://gql.twitch.tv/gql";
/** Client-ID público del reproductor web de Twitch (no es un secreto: va en cada página de twitch.tv). */
const WEB_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const COMMENTS_QUERY_HASH = "b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c582044aa76adf6a";

/** El chat reacciona unos segundos DESPUÉS de lo que pasa en el video. */
export const CHAT_DELAY_SECONDS = 6;

/** Id numérico de un VOD de Twitch (twitch.tv/videos/123…). Clips y canales en vivo: null. */
export function twitchVideoId(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!/(^|\.)twitch\.tv$/i.test(u.hostname)) return null;
    return /^\/videos\/(\d+)/.exec(u.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

interface CommentNode {
  contentOffsetSeconds?: number;
  commenter?: { login?: string | null } | null;
  message?: {
    fragments?: { text?: string | null; emote?: unknown }[] | null;
  } | null;
}

/** Bots que anuncian subs, donaciones y bits en el chat. */
const ALERT_BOTS = new Set(["streamelements", "streamlabs", "nightbot", "moobot", "fossabot", "wizebot", "botrixoficial", "sery_bot"]);
const ALERT_WORDS = /(^|[^\p{L}])(don\p{L}*|tips?|subs?|subscri\p{L}*|suscri\p{L}*|regal\p{L}*|gift\p{L}*|bits?|cheer\p{L}*|raid\p{L}*)(?!\p{L})/iu;
/** Risas y reacciones típicas del chat (en español e inglés). */
const HYPE_WORDS =
  /\b(lul|lol|kekw?|omegalul|xd+|ja(ja)+|je(je)+|ks(ks)+|lmao|pog\w*|clip(it)?|wtf|omg|gg|w+|l+|no+ ma+mes|sheesh|monka\w*)\b/i;
const CHEER = /\b[a-z]*cheer(\d+)\b/gi;

/** Peso de un mensaje: más si trae emotes/risas, bits o es un aviso de sub/donación. */
export function messageWeight(node: CommentNode): number {
  const fragments = node.message?.fragments ?? [];
  const text = fragments.map((f) => f.text ?? "").join("");
  let weight = 1;
  if (fragments.some((f) => f.emote) || HYPE_WORDS.test(text)) weight += 0.5;
  let bits = 0;
  for (const m of text.matchAll(CHEER)) bits += Number(m[1]) || 0;
  if (bits > 0) weight += Math.min(4, 1 + bits / 100);
  const login = node.commenter?.login?.toLowerCase() ?? "";
  if (ALERT_BOTS.has(login) && ALERT_WORDS.test(text)) weight += 3;
  return weight;
}

export interface ChatActivity {
  /** Actividad por segundo del video (ya corrida por el retraso del chat). */
  series: number[];
  /** Mensajes leídos en total (muestra, no el chat completo). */
  messages: number;
  samples: number;
}

export interface ChatOptions {
  fetch?: typeof fetch;
  /** Cada cuántos segundos se toma una muestra del chat. */
  stepSeconds?: number;
  concurrency?: number;
  maxRequests?: number;
  signal?: AbortSignal;
  /** Fecha límite (ms epoch): lo que no se leyó a tiempo se trata como sin datos. */
  deadline?: number;
}

type Sample = { rate: number; messages: number } | null;

async function readPage(videoId: string, offset: number, fetchFn: typeof fetch, signal?: AbortSignal) {
  const res = await fetchFn(GQL_URL, {
    method: "POST",
    headers: { "Client-ID": WEB_CLIENT_ID, "Content-Type": "application/json" },
    body: JSON.stringify([
      {
        operationName: "VideoCommentsByOffsetOrCursor",
        variables: { videoID: videoId, contentOffsetSeconds: Math.floor(offset) },
        extensions: { persistedQuery: { version: 1, sha256Hash: COMMENTS_QUERY_HASH } },
      },
    ]),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as unknown;
  const first = (Array.isArray(body) ? body[0] : body) as {
    data?: { video?: { comments?: { edges?: { node?: CommentNode }[]; pageInfo?: { hasNextPage?: boolean } } | null } | null };
  };
  // El VOD no existe (o se borró): no hay chat que leer.
  if (first?.data && first.data.video === null) return null;
  const comments = first?.data?.video?.comments;
  // "service error" puntual de Twitch: cuenta como muestra fallida, no como "sin chat".
  if (!comments) throw new Error("chat no disponible en este tramo");
  return {
    nodes: (comments.edges ?? []).map((e) => e.node).filter((n): n is CommentNode => Boolean(n)),
    hasNextPage: Boolean(comments.pageInfo?.hasNextPage),
  };
}

/**
 * Mide la actividad del chat de un VOD de Twitch. Toma una página de mensajes cada
 * `stepSeconds` y calcula mensajes (ponderados) por segundo en esa ventana.
 */
export async function fetchTwitchChatActivity(
  videoId: string,
  durationSeconds: number,
  options: ChatOptions = {},
): Promise<ChatActivity | null> {
  const duration = Math.max(0, Math.floor(durationSeconds));
  if (duration < 1) return null;
  const fetchFn = options.fetch ?? fetch;
  const maxRequests = options.maxRequests ?? 900;
  const step = Math.max(options.stepSeconds ?? 15, Math.ceil(duration / maxRequests));
  const offsets: number[] = [];
  for (let t = 0; t < duration; t += step) offsets.push(t);

  const samples: Sample[] = offsets.map(() => null);
  let failures = 0;
  let videoMissing = false;
  let next = 0;
  const work = async () => {
    while (next < offsets.length && !videoMissing) {
      const i = next++;
      if (options.signal?.aborted || (options.deadline && Date.now() > options.deadline)) return;
      const start = offsets[i]!;
      const end = Math.min(duration, start + step);
      try {
        const page = await readPage(videoId, start, fetchFn, options.signal);
        if (!page) {
          videoMissing = true;
          return;
        }
        const inWindow = page.nodes.filter((n) => {
          const o = n.contentOffsetSeconds ?? -1;
          return o >= start && o < end;
        });
        const lastOffset = page.nodes.at(-1)?.contentOffsetSeconds ?? start;
        // Si la página se acabó antes del final de la ventana, el chat iba muy rápido:
        // medimos sobre el tramo que sí cubre la página.
        const covered = page.hasNextPage && lastOffset < end ? Math.max(1, lastOffset - start) : end - start;
        const weight = inWindow.reduce((sum, n) => sum + messageWeight(n), 0);
        samples[i] = { rate: weight / Math.max(1, covered), messages: inWindow.length };
      } catch {
        failures++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 6, offsets.length) }, work));

  const ok = samples.filter((s): s is NonNullable<Sample> => s !== null);
  const messages = ok.reduce((sum, s) => sum + s.messages, 0);
  // Sin chat (desactivado, VOD sin repetición del chat) o demasiados errores: no aporta nada.
  if (videoMissing || messages === 0 || ok.length < offsets.length / 2 || failures > offsets.length / 2) return null;

  // Interpolación lineal entre los centros de cada ventana; los huecos sin datos se saltan.
  const points = samples
    .map((s, i) => (s ? { t: offsets[i]! + Math.min(step, duration - offsets[i]!) / 2, v: s.rate } : null))
    .filter((p): p is { t: number; v: number } => p !== null);
  const valueAt = (t: number) => {
    if (t <= points[0]!.t) return points[0]!.v;
    const last = points.at(-1)!;
    if (t >= last.t) return last.v;
    let lo = 0;
    let hi = points.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (points[mid]!.t <= t) lo = mid;
      else hi = mid;
    }
    const a = points[lo]!;
    const b = points[hi]!;
    return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
  };
  // El segundo t del video se puntúa con lo que el chat dijo CHAT_DELAY_SECONDS después.
  const series = Array.from({ length: duration }, (_, t) => valueAt(t + 0.5 + CHAT_DELAY_SECONDS));
  return { series, messages, samples: ok.length };
}
