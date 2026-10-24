import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PRODUCT_CONFIG, type LinkPreview } from "@clipflow/shared";
import { BILLING_OFF } from "./billing.js";
import { fetchLinkDetails, fetchLinkPreview, kickRecord } from "./link-preview.js";
import { bearer, closeTestApp, createTestApp, type TestContext } from "./test-helpers.js";

/** fetch falso: anota a dónde se pidió y responde lo que diga `reply`. */
function fakeFetch(reply: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return reply(url, init);
  }) as typeof fetch;
  return { fn, calls };
}

describe("tarjeta del enlace (sin bajar el video)", () => {
  it("Twitch: video guardado con título, duración y miniatura (API de Twitch)", async () => {
    const f = fakeFetch(() =>
      Response.json({ data: { video: { title: "  Stream   largo ", lengthSeconds: 9616, previewThumbnailURL: "https://static-cdn.jtvnw.net/x.jpg" } } }),
    );
    const preview = await fetchLinkPreview("https://www.twitch.tv/videos/2885611944", { fetch: f.fn });
    expect(preview).toEqual<LinkPreview>({ platform: "Twitch", title: "Stream largo", durationSeconds: 9616, thumbnailUrl: "https://static-cdn.jtvnw.net/x.jpg" });
    expect(f.calls[0]!.url).toBe("https://gql.twitch.tv/gql");
    expect(JSON.parse(String(f.calls[0]!.init!.body)).variables).toEqual({ id: "2885611944" });
  });

  it("Twitch: clip", async () => {
    const f = fakeFetch(() => Response.json({ data: { clip: { title: "Gol", durationSeconds: 28.4, thumbnailURL: "https://clips-media.twitch.tv/t.jpg" } } }));
    const preview = await fetchLinkPreview("https://www.twitch.tv/canal/clip/AbcDef-123", { fetch: f.fn });
    expect(preview).toMatchObject({ platform: "Twitch", title: "Gol", durationSeconds: 28 });
    expect(JSON.parse(String(f.calls[0]!.init!.body)).variables).toEqual({ slug: "AbcDef-123" });
  });

  it("Kick: lee el registro de la página del video (duración en segundos)", async () => {
    const id = "01a0b24f-2b40-7d20-b9d1-f1238dd1b2e7";
    const record = { id, title: 'Torneo "PVP"', duration: 7642, recording_url: "https://stream.kick.com/x.m3u8", thumbnail: { src: "https://images.kick.com/t/720.webp" } };
    // En la página viene como JSON escapado dentro de un <script>.
    const html = `<html><script>self.__next_f.push([1,"${JSON.stringify({ other: { id, foo: 1 }, video: record }).replace(/"/g, '\\"')}"])</script></html>`;
    const f = fakeFetch(() => new Response(html, { status: 200 }));
    const preview = await fetchLinkPreview(`https://kick.com/punicher/videos/${id}`, { fetch: f.fn });
    expect(preview).toEqual({ platform: "Kick", title: 'Torneo "PVP"', durationSeconds: 7642, thumbnailUrl: "https://images.kick.com/t/720.webp" });
    // Siempre a kick.com con el canal y el código: nunca a otra dirección.
    expect(f.calls[0]!.url).toBe(`https://kick.com/punicher/videos/${id}`);
  });

  it("TikTok: oEmbed (título y miniatura, sin duración)", async () => {
    const f = fakeFetch(() => Response.json({ title: "Mi baile", thumbnail_url: "https://p16.tiktokcdn.com/t.jpg" }));
    const preview = await fetchLinkPreview("https://www.tiktok.com/@ana/video/1", { fetch: f.fn });
    expect(preview).toEqual({ platform: "TikTok", title: "Mi baile", durationSeconds: null, thumbnailUrl: "https://p16.tiktokcdn.com/t.jpg" });
    expect(f.calls[0]!.url).toBe(`https://www.tiktok.com/oembed?url=${encodeURIComponent("https://www.tiktok.com/@ana/video/1")}`);
  });

  it("YouTube: título por oEmbed y duración de la página (direcciones armadas con el código del video)", async () => {
    const f = fakeFetch((url) =>
      url.includes("/oembed")
        ? Response.json({ title: "Charla" })
        : new Response('<html><script>var x = {"videoDetails":{"lengthSeconds":"5432"}}</script></html>'),
    );
    const preview = await fetchLinkPreview("https://youtu.be/dQw4w9WgXcQ?si=abc", { fetch: f.fn });
    expect(preview).toEqual({ platform: "YouTube", title: "Charla", durationSeconds: 5432, thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" });
    expect(f.calls.map((c) => c.url).sort()).toEqual([
      "https://www.youtube.com/oembed?format=json&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    ]);
    // Shorts y en vivo también; un enlace sin código de video, sin datos.
    expect((await fetchLinkPreview("https://m.youtube.com/shorts/dQw4w9WgXcQ", { fetch: f.fn }))?.durationSeconds).toBe(5432);
    expect(await fetchLinkPreview("https://www.youtube.com/@canal", { fetch: f.fn })).toEqual({ platform: "YouTube", title: null, durationSeconds: null, thumbnailUrl: null });
  });

  it("Instagram y Facebook: tarjeta sin datos y sin consultar nada", async () => {
    const f = fakeFetch(() => Response.json({}));
    expect(await fetchLinkPreview("https://www.instagram.com/reel/abc/", { fetch: f.fn })).toEqual({ platform: "Instagram", title: null, durationSeconds: null, thumbnailUrl: null });
    expect(f.calls).toHaveLength(0);
  });

  it("si la plataforma falla o tarda, la tarjeta sale sin datos (nunca un error)", async () => {
    const slow = fakeFetch((_u, init) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    const started = Date.now();
    const preview = await fetchLinkPreview("https://www.twitch.tv/videos/1", { fetch: slow.fn, timeoutMs: 100 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(preview).toEqual({ platform: "Twitch", title: null, durationSeconds: null, thumbnailUrl: null });
    const broken = fakeFetch(() => new Response("no", { status: 500 }));
    expect(await fetchLinkPreview("https://kick.com/a/videos/01a0b24f-2b40-7d20-b9d1-f1238dd1b2e7", { fetch: broken.fn })).toMatchObject({ title: null });
  });

  it("solo acepta miniaturas https", () => {
    const id = "01a0b24f-2b40-7d20-b9d1-f1238dd1b2e7";
    expect(kickRecord(`{"id":"${id}","recording_url":"x","thumbnail":{"src":"javascript:alert(1)"}}`, id)).toMatchObject({ id });
  });
});

describe("segundo paso: la duración leída como el procesador (Python con yt-dlp)", () => {
  /** Script de Python falso: dice qué recibió y responde como el de verdad. */
  function fakeScript(body: string) {
    const dir = mkdtempSync(path.join(tmpdir(), "link-meta-"));
    const file = path.join(dir, "fake.py");
    writeFileSync(file, `import json, os, sys\n${body}\n`);
    return file;
  }

  it("devuelve título, duración y miniatura (sin pasarle las claves de la API)", async () => {
    const script = fakeScript(
      'print(json.dumps({"title": sys.argv[1], "durationSeconds": 7642.4, "thumbnailUrl": "https://images.kick.com/t.webp" if "DATABASE_URL" not in os.environ else None}))',
    );
    process.env.DATABASE_URL ??= "postgres://secreto";
    const details = await fetchLinkDetails("https://kick.com/a/videos/01a0b24f-2b40-7d20-b9d1-f1238dd1b2e7", { python: "python3", script });
    expect(details).toEqual({ title: "https://kick.com/a/videos/01a0b24f-2b40-7d20-b9d1-f1238dd1b2e7", durationSeconds: 7642, thumbnailUrl: "https://images.kick.com/t.webp" });
  });

  it("sin duración, devuelve el motivo (para el registro)", async () => {
    const script = fakeScript('print(json.dumps({"errors": ["RuntimeError: pide iniciar sesión", 7]}))');
    const details = await fetchLinkDetails("https://www.facebook.com/share/v/1BuH8sY2Lx/", { python: "python3", script });
    expect(details).toMatchObject({ durationSeconds: null, errors: ["RuntimeError: pide iniciar sesión"] });
  });

  it("si falla, tarda o responde cualquier cosa: null o sin datos (nunca un error)", async () => {
    const broken = fakeScript("raise SystemExit(3)");
    expect(await fetchLinkDetails("https://www.tiktok.com/@a/video/1", { python: "python3", script: broken })).toEqual({ title: null, durationSeconds: null, thumbnailUrl: null });
    const slow = fakeScript("import time\ntime.sleep(5)");
    const started = Date.now();
    await fetchLinkDetails("https://www.tiktok.com/@a/video/1", { python: "python3", script: slow, timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await fetchLinkDetails("https://www.tiktok.com/@a/video/1", { python: "/no/existe", script: slow })).toEqual({ title: null, durationSeconds: null, thumbnailUrl: null });
    // Solo plataformas conocidas.
    expect(await fetchLinkDetails("https://example.com/v.mp4", { python: "python3", script: slow })).toBeNull();
  });

});

describe("POST /videos/preview", () => {
  let ctx: TestContext | undefined;
  afterEach(async () => {
    await closeTestApp(ctx);
    ctx = undefined;
  });

  it("devuelve la tarjeta, revisa el enlace y guarda la respuesta unos minutos", async () => {
    let calls = 0;
    ctx = await createTestApp(DEFAULT_PRODUCT_CONFIG, BILLING_OFF, {
      linkPreview: async () => {
        calls++;
        return { platform: "Kick", title: "Stream", durationSeconds: 9616, thumbnailUrl: null };
      },
    });
    const ask = (url: string) => ctx!.app.inject({ method: "POST", url: "/videos/preview", headers: bearer("alice"), payload: { url } });
    const first = await ask("https://kick.com/canal/videos/01a0b24f-2b40-7d20-b9d1-f1238dd1b2e8");
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ preview: { platform: "Kick", title: "Stream", durationSeconds: 9616, thumbnailUrl: null } });
    await ask("https://kick.com/canal/videos/01a0b24f-2b40-7d20-b9d1-f1238dd1b2e8");
    expect(calls).toBe(1);
    // Segundo paso: completa la duración que faltaba.
    expect((await ctx!.app.inject({ method: "POST", url: "/videos/preview", headers: bearer("alice"), payload: { url: "https://kick.com/canal/videos/01a0b24f-2b40-7d20-b9d1-f1238dd1b2e8", deep: true } })).json()).toMatchObject({
      preview: { durationSeconds: 9616 },
    });
    // YouTube solo para administradores: al resto se lo dice antes de intentar.
    const yt = await ask("https://www.youtube.com/watch?v=x");
    expect(yt.statusCode).toBe(400);
    expect(yt.json().error.message).toContain("YouTube");
    // Sin sesión, no.
    expect((await ctx.app.inject({ method: "POST", url: "/videos/preview", payload: { url: "https://kick.com/a/videos/1" } })).statusCode).toBe(401);
  });
});

describe("POST /videos/preview con deep (segundo paso)", () => {
  let ctx: TestContext | undefined;
  afterEach(async () => {
    await closeTestApp(ctx);
    ctx = undefined;
  });

  it("completa lo que la consulta rápida no trajo (Kick bloqueado, TikTok sin duración)", async () => {
    ctx = await createTestApp(DEFAULT_PRODUCT_CONFIG, BILLING_OFF, {
      linkPreview: async () => ({ platform: "TikTok", title: "Mi baile", durationSeconds: null, thumbnailUrl: "https://p16.tiktokcdn.com/a.jpg" }),
      linkDetails: async () => ({ title: "otro", durationSeconds: 1310, thumbnailUrl: "https://p16.tiktokcdn.com/b.jpg" }),
    });
    const res = await ctx.app.inject({ method: "POST", url: "/videos/preview", headers: bearer("alice"), payload: { url: "https://www.tiktok.com/@ana/video/9", deep: true } });
    expect(res.json()).toEqual({ preview: { platform: "TikTok", title: "Mi baile", durationSeconds: 1310, thumbnailUrl: "https://p16.tiktokcdn.com/a.jpg" } });
  });
});
