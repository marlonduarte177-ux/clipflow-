import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchYoutubeViaApify, isApifyToken } from "./apify.js";
import { DownloadError, downloadFromUrl } from "./download.js";

const TOKEN = "apify_api_abcdefghijklmnopqrstuvwxyz0123";
const YT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

/** API de Apify falsa: la ejecución pasa por RUNNING y termina con `final`. */
function fakeApify(final: string, items: unknown[] = [], status = 201) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let polls = 0;
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("/acts/") && init?.method === "POST") {
      return Response.json({ data: { id: "run1", status: "READY", defaultDatasetId: "ds1" } }, { status });
    }
    if (url.includes("/actor-runs/run1?")) {
      polls++;
      return Response.json({ data: { id: "run1", status: polls < 2 ? "RUNNING" : final, defaultDatasetId: "ds1" } });
    }
    if (url.includes("/datasets/ds1/items")) return Response.json(items);
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { fn, calls };
}

let dir: string;
let server: Server;
let base: string;
let sample: Buffer;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "apify-test-"));
  const file = path.join(dir, "sample.mp4");
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:duration=1", "-c:v", "libx264", "-preset", "ultrafast", file]);
  sample = readFileSync(file);
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "video/mp4", "content-length": sample.length });
    res.end(sample);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("YouTube con Apify (solo administradores)", () => {
  it("reconoce la clave real y no el valor de relleno de AWS", () => {
    expect(isApifyToken(TOKEN)).toBe(true);
    expect(isApifyToken(` ${TOKEN}\n`)).toBe(true);
    expect(isApifyToken("Xk3r9QwPz7LmN2vB8tY4uH6jD1sF5gA0")).toBe(false);
    expect(isApifyToken(undefined)).toBe(false);
  });

  it("pide 1080p sin almacenamiento, espera a que termine y devuelve el enlace (clave en la cabecera, nunca en la URL)", async () => {
    const api = fakeApify("SUCCEEDED", [{ title: "Charla", downloadUrl: `${base}/v.mp4`, status: "completed" }]);
    const result = await fetchYoutubeViaApify(YT, { token: TOKEN, fetch: api.fn, waitSeconds: 1 });
    expect(result).toEqual({ downloadUrl: `${base}/v.mp4`, title: "Charla" });
    const start = api.calls[0]!;
    expect(start.url).toContain("/acts/api-ninja~youtube-video-downloader/runs?");
    expect(JSON.parse(String(start.init!.body))).toEqual({ urls: [YT], format: "1080", ttl: "none" });
    for (const c of api.calls) {
      expect(c.url).not.toContain(TOKEN);
      expect((c.init!.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    }
  });

  it("errores claros: clave inválida, sin saldo, video privado y ejecución fallida", async () => {
    const fail = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as DownloadError);
    expect((await fail(fetchYoutubeViaApify(YT, { token: TOKEN, fetch: fakeApify("SUCCEEDED", [], 401).fn })))!.message).toContain("clave de Apify");
    expect((await fail(fetchYoutubeViaApify(YT, { token: TOKEN, fetch: fakeApify("SUCCEEDED", [], 402).fn })))!.message).toContain("saldo");
    expect((await fail(fetchYoutubeViaApify(YT, { token: TOKEN, fetch: fakeApify("SUCCEEDED", []).fn, waitSeconds: 1 })))!.message).toContain("privado");
    const failed = await fail(fetchYoutubeViaApify(YT, { token: TOKEN, fetch: fakeApify("FAILED").fn, waitSeconds: 1 }));
    expect(failed).toBeInstanceOf(DownloadError);
    expect(failed!.retryable).toBe(false);
    expect(failed!.detail).toBe("apify: FAILED");
  });

  it("downloadFromUrl: baja de YouTube con Apify y guarda el título; sin clave, lo dice", async () => {
    const work = mkdtempSync(path.join(dir, "w-"));
    const api = fakeApify("SUCCEEDED", [{ title: "Charla", downloadUrl: `${base}/v.mp4` }]);
    const options = { ytDlpPath: "yt-dlp", ffmpegPath: "ffmpeg", maxBytes: 10 ** 9, maxDurationSeconds: 3600, allowHosts: ["127.0.0.1"] };
    const got = await downloadFromUrl(YT, work, { ...options, apifyToken: TOKEN, apify: { fetch: api.fn, waitSeconds: 1 } });
    expect(got.title).toBe("Charla");
    expect(got.sizeBytes).toBe(sample.length);
    await expect(downloadFromUrl(YT, work, { ...options, apifyToken: "relleno" })).rejects.toThrow("falta la clave de Apify");
  });
});
