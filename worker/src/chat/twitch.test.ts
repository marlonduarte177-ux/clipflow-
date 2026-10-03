import { describe, expect, it } from "vitest";
import { CHAT_DELAY_SECONDS, fetchTwitchChatActivity, messageWeight, twitchVideoId } from "./twitch.js";

describe("twitchVideoId", () => {
  it("saca el id de los VODs y descarta clips, canales y otros sitios", () => {
    expect(twitchVideoId("https://www.twitch.tv/videos/2885611944")).toBe("2885611944");
    expect(twitchVideoId("https://m.twitch.tv/videos/123?t=1h2m")).toBe("123");
    expect(twitchVideoId("https://www.twitch.tv/canal/clip/AbcDef")).toBeNull();
    expect(twitchVideoId("https://www.twitch.tv/canal")).toBeNull();
    expect(twitchVideoId("https://twitch.tv.evil.com/videos/1")).toBeNull();
    expect(twitchVideoId(null)).toBeNull();
    expect(twitchVideoId("no es un enlace")).toBeNull();
  });
});

const msg = (offset: number, text = "hola", extra: { emote?: boolean; login?: string } = {}) => ({
  contentOffsetSeconds: offset,
  commenter: { login: extra.login ?? "alguien" },
  message: { fragments: [{ text, emote: extra.emote ? { emoteID: "1" } : null }] },
});

describe("messageWeight", () => {
  it("pesa más emotes y risas, bits y avisos de subs o donaciones", () => {
    expect(messageWeight(msg(0))).toBe(1);
    expect(messageWeight(msg(0, "KEKW"))).toBe(1.5);
    expect(messageWeight(msg(0, "", { emote: true }))).toBe(1.5);
    expect(messageWeight(msg(0, "jajaja que paso"))).toBe(1.5);
    expect(messageWeight(msg(0, "Cheer500 vamos"))).toBe(5); // 1 + min(4, 1 + 500/100)
    expect(messageWeight(msg(0, "Gracias Pepe por la donación de $5", { login: "StreamElements" }))).toBe(4);
    // Un mensaje normal de un bot (comandos, enlaces) no cuenta como evento.
    expect(messageWeight(msg(0, "Sígueme en instagram", { login: "nightbot" }))).toBe(1);
    expect(messageWeight(msg(0, "Ana se suscribió con Prime", { login: "botrixoficial" }))).toBe(4);
    // "subrayado" no es un sub.
    expect(messageWeight(msg(0, "texto subrayado", { login: "nightbot" }))).toBe(1);
  });
});

/** Un chat falso: `perSecond(t)` mensajes en el segundo t; páginas de 50 como la API real. */
function fakeChat(duration: number, perSecond: (t: number) => number) {
  const all: ReturnType<typeof msg>[] = [];
  for (let t = 0; t < duration; t++) for (let k = 0; k < perSecond(t); k++) all.push(msg(t + k / 100));
  const requests: number[] = [];
  const fetchFn = (async (_url: string, init: { body: string }) => {
    const offset = JSON.parse(init.body)[0].variables.contentOffsetSeconds as number;
    requests.push(offset);
    const from = all.findIndex((m) => m.contentOffsetSeconds >= offset);
    const page = from < 0 ? [] : all.slice(from, from + 50);
    const hasNextPage = from >= 0 && from + 50 < all.length;
    return new Response(
      JSON.stringify([{ data: { video: { comments: { edges: page.map((node) => ({ node })), pageInfo: { hasNextPage } } } } }]),
    );
  }) as unknown as typeof fetch;
  return { fetchFn, requests };
}

describe("fetchTwitchChatActivity", () => {
  it("encuentra el pico del chat y lo corre unos segundos antes (el chat reacciona tarde)", async () => {
    // Chat tranquilo (1 msg cada 5 s) y una explosión entre 120 y 135 s (20 msg/s).
    const { fetchFn, requests } = fakeChat(300, (t) => (t >= 120 && t < 135 ? 20 : t % 5 === 0 ? 1 : 0));
    const activity = await fetchTwitchChatActivity("1", 300, { fetch: fetchFn, stepSeconds: 15 });
    expect(activity).not.toBeNull();
    expect(requests).toHaveLength(20);
    expect(activity!.series).toHaveLength(300);
    const peak = activity!.series.indexOf(Math.max(...activity!.series));
    expect(peak).toBeGreaterThanOrEqual(120 - CHAT_DELAY_SECONDS - 8);
    expect(peak).toBeLessThan(135 - CHAT_DELAY_SECONDS);
    // El pico (página llena antes de terminar la ventana) se mide sobre el tramo cubierto: ~20 msg/s.
    expect(Math.max(...activity!.series)).toBeGreaterThan(10);
    expect(activity!.series[30]!).toBeLessThan(0.5);
  });

  it("limita las consultas en streams muy largos", async () => {
    const { fetchFn, requests } = fakeChat(3 * 3600, (t) => (t % 10 === 0 ? 1 : 0));
    const activity = await fetchTwitchChatActivity("1", 3 * 3600, { fetch: fetchFn, maxRequests: 100 });
    expect(requests.length).toBeLessThanOrEqual(100);
    expect(activity!.series).toHaveLength(3 * 3600);
  });

  it("sin chat, video sin repetición del chat o la API caída: null (nunca lanza)", async () => {
    const empty = fakeChat(60, () => 0);
    expect(await fetchTwitchChatActivity("1", 60, { fetch: empty.fetchFn })).toBeNull();

    const noVideo = (async () => new Response(JSON.stringify([{ data: { video: null } }]))) as unknown as typeof fetch;
    expect(await fetchTwitchChatActivity("1", 60, { fetch: noVideo })).toBeNull();

    const down = (async () => new Response("error", { status: 500 })) as unknown as typeof fetch;
    expect(await fetchTwitchChatActivity("1", 60, { fetch: down })).toBeNull();

    const throwing = (async () => {
      throw new Error("red caída");
    }) as unknown as typeof fetch;
    expect(await fetchTwitchChatActivity("1", 60, { fetch: throwing })).toBeNull();
  });
});
