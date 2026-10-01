import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DownloadError, downloadFromUrl, downloadWithYtDlp, isPlatformUrl, ytDlpErrorMessage } from "./download.js";

/** yt-dlp instalado (en la imagen del worker sí; en CI puede no estar). */
const YTDLP = process.env.YTDLP_PATH ?? "yt-dlp";
let hasYtDlp = false;
try {
  execFileSync(YTDLP, ["--version"], { stdio: "ignore" });
  hasYtDlp = true;
} catch {
  hasYtDlp = false;
}

let dir: string;
let server: Server;
let base: string;
let sample: Buffer;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "download-test-"));
  const file = path.join(dir, "sample.mp4");
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:duration=2", "-c:v", "libx264", "-preset", "ultrafast", file]);
  sample = readFileSync(file);
  server = createServer((req, res) => {
    if (req.url === "/video.mp4") {
      res.writeHead(200, { "content-type": "video/mp4", "content-length": sample.length });
      return res.end(sample);
    }
    if (req.url === "/redirect") return res.writeHead(302, { location: "/video.mp4" }).end();
    if (req.url === "/to-metadata") return res.writeHead(302, { location: "http://169.254.170.2/v2/credentials" }).end();
    if (req.url === "/page") return res.writeHead(200, { "content-type": "text/html" }).end("<html>hola</html>");
    if (req.url === "/huge") return res.writeHead(200, { "content-type": "video/mp4", "content-length": String(50 * 1024 ** 3) }).end();
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const options = (extra: Record<string, unknown> = {}) => ({
  ytDlpPath: "yt-dlp",
  ffmpegPath: "ffmpeg",
  maxBytes: 10 * 1024 ** 3,
  maxDurationSeconds: 3 * 3600,
  allowHosts: ["127.0.0.1"], // el servidor de prueba es local
  ...extra,
});
const target = (name: string) => {
  const d = path.join(dir, name);
  execFileSync("mkdir", ["-p", d]);
  return d;
};

describe("descarga por enlace directo", () => {
  it("descarga el archivo (también tras una redirección) e informa el avance", async () => {
    const progress: number[] = [];
    const result = await downloadFromUrl(`${base}/redirect`, target("ok"), options({ onProgress: (f: number) => progress.push(f) }));
    expect(result.sizeBytes).toBe(sample.length);
    expect(readFileSync(result.file).equals(sample)).toBe(true);
    expect(path.basename(result.file)).toBe("source.mp4");
    expect(progress.at(-1)).toBe(1);
  });

  it("nunca se conecta a direcciones internas: ni locales ni redirigiendo a los metadatos de AWS", async () => {
    // Sin la excepción del test, 127.0.0.1 está prohibido.
    await expect(downloadFromUrl(`${base}/video.mp4`, target("local"), options({ allowHosts: [] }))).rejects.toThrow(/dirección privada/);
    await expect(downloadFromUrl(`${base}/to-metadata`, target("meta"), options())).rejects.toThrow(/dirección privada/);
  });

  it("explica cuando el enlace es una página y no un video, o cuando es demasiado grande", async () => {
    await expect(downloadFromUrl(`${base}/page`, target("page"), options())).rejects.toThrow(/no es un archivo de video/);
    await expect(downloadFromUrl(`${base}/huge`, target("huge"), options())).rejects.toThrow(/tamaño máximo/);
    const missing = await downloadFromUrl(`${base}/nada.mp4`, target("404"), options()).catch((e) => e);
    expect(missing).toBeInstanceOf(DownloadError);
    expect(missing).toMatchObject({ retryable: false });
  });
});

describe("plataformas (yt-dlp)", () => {
  it("reconoce los enlaces de plataformas", () => {
    for (const u of ["https://www.youtube.com/watch?v=x", "https://youtu.be/x", "https://vm.tiktok.com/x", "https://www.instagram.com/reel/x", "https://x.com/a/status/1", "https://vimeo.com/1"]) {
      expect(isPlatformUrl(u), u).toBe(true);
    }
    for (const u of ["https://example.com/v.mp4", "https://notyoutube.com/x", "https://youtube.com.evil.com/x"]) {
      expect(isPlatformUrl(u), u).toBe(false);
    }
  });

  it("traduce los errores de yt-dlp a mensajes claros", () => {
    expect(ytDlpErrorMessage("ERROR: [youtube] x: Sign in to confirm you’re not a bot").message).toMatch(/bloqueó la descarga/);
    expect(ytDlpErrorMessage("ERROR: [youtube] x: Private video. Sign in if you've been granted access").message).toMatch(/privado/);
    expect(ytDlpErrorMessage("[download] x does not pass filter (duration <=? 10800 & !is_live), skipping ..").message).toMatch(/duración máxima/);
    expect(ytDlpErrorMessage("ERROR: Unsupported URL: https://example.com").message).toMatch(/No encontramos/);
    expect(ytDlpErrorMessage("ERROR: unable to download: HTTP Error 503").retryable).toBe(true);
    expect(ytDlpErrorMessage("ERROR: unable to download video data: HTTP Error 403: Forbidden").message).toMatch(/bloqueó la descarga/);
    expect(ytDlpErrorMessage("ERROR: [vimeo] 1: The web client only works when logged-in.").message).toMatch(/iniciar sesión/);
    expect(ytDlpErrorMessage("ERROR: [TikTok] 1: Unexpected response from webpage request; please report this issue").message).toMatch(/no permitió descargar/);
    // "page" o "message" no se confunden con "edad".
    expect(ytDlpErrorMessage("ERROR: something about the page message").message).toBe("No pudimos descargar el video de ese enlace.");
  });

  it.skipIf(!hasYtDlp)("con yt-dlp real: descarga, informa el avance y devuelve el archivo final", async () => {
    const progress: number[] = [];
    const result = await downloadWithYtDlp(`${base}/video.mp4`, target("ytdlp"), {
      ...options(),
      ytDlpPath: YTDLP,
      onProgress: (f) => progress.push(f),
    });
    expect(path.basename(result.file)).toBe("source.mp4");
    expect(readFileSync(result.file).length).toBe(sample.length);
    expect(result.title).toBe("video");
    expect(progress.at(-1)).toBe(1);
  });
});
