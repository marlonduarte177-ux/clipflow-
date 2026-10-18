import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DownloadError,
  downloadFromUrl,
  downloadWithYtDlp,
  ffmpegLocationArgs,
  isPlatformUrl,
  redactCredentials,
  YTDLP_PLUGINS_DIR,
  ytDlpErrorMessage,
} from "./download.js";

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
  it("rechaza YouTube con un mensaje claro aunque llegue un enlace guardado antes", async () => {
    await expect(downloadFromUrl("https://youtu.be/abc", target("yt"), options())).rejects.toThrow(/no se pueden importar videos de YouTube/);
  });

  it("le pasa a yt-dlp la ruta COMPLETA de FFmpeg (con solo el nombre, yt-dlp seguía sin FFmpeg)", () => {
    const args = ffmpegLocationArgs("ffmpeg");
    expect(args[0]).toBe("--ffmpeg-location");
    expect(path.isAbsolute(args[1]!)).toBe(true);
    expect(ffmpegLocationArgs("/usr/bin/ffmpeg")).toEqual(["--ffmpeg-location", "/usr/bin/ffmpeg"]);
    expect(ffmpegLocationArgs("no-existe-este-programa")).toEqual([]);
  });

  it("reconoce los enlaces de plataformas", () => {
    for (const u of ["https://vm.tiktok.com/x", "https://www.instagram.com/reel/x", "https://www.facebook.com/watch?v=1", "https://fb.watch/x", "https://kick.com/spreen/clips/clip_1", "https://www.twitch.tv/videos/1"]) {
      expect(isPlatformUrl(u), u).toBe(true);
    }
    for (const u of ["https://example.com/v.mp4", "https://youtu.be/x", "https://vimeo.com/1", "https://tiktok.com.evil.com/x"]) {
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
    // Twitch: solo suscriptores y video borrado.
    const subs = ytDlpErrorMessage("ERROR: [twitch:vod] 1: You must be logged into an account that has access to this subscriber-only content");
    expect(subs.message).toMatch(/solo para suscriptores/);
    expect(subs.blocked).toBeFalsy();
    expect(ytDlpErrorMessage("ERROR: [twitch:vod] 1: Video 1 does not exist").message).toMatch(/No encontramos/);
    // Canal de Kick sin transmitir: se explica qué enlace pegar.
    expect(ytDlpErrorMessage("ERROR: [kick:live] a-log-burner: The channel is not currently live").message).toMatch(/enlace de un clip o de un video guardado/);
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

describe("plataformas con yt-dlp (sin proxy)", () => {
  /**
   * yt-dlp falso: anota cómo lo llamaron y "descarga". Con `blocked`, responde como Instagram a un
   * servidor de nube ("login required").
   */
  function fakeYtDlp(name: string, blocked = false) {
    const d = target(name);
    const script = path.join(d, "yt-dlp.sh");
    writeFileSync(
      script,
      [
        "#!/bin/sh",
        'out=""; proxy=""; sort=""; xargs=""; prev=""',
        'for a in "$@"; do',
        '  [ "$prev" = "-o" ] && out="$a"',
        '  [ "$a" = "--proxy" ] && proxy="sí"',
        '  [ "$prev" = "-S" ] && sort="$a"',
        '  [ "$prev" = "--extractor-args" ] && xargs="$xargs $a"',
        '  [ "$prev" = "--plugin-dirs" ] && xargs="$xargs plugins=$a"',
        '  [ "$prev" = "--download-sections" ] && xargs="$xargs sections=$a"',
        '  [ "$prev" = "--match-filters" ] && xargs="$xargs filter=$(echo "$a" | tr -d " ")"',
        '  prev="$a"',
        "done",
        'echo "call proxy=$proxy sort=$sort$xargs" >> "$(dirname "$0")/calls.log"',
        ...(blocked
          ? ['echo "ERROR: [Instagram] x: Requested content is not available, rate-limit reached or login required (http://user:clave@host:1000)" >&2; exit 1']
          : []),
        'file=$(echo "$out" | sed "s/%(ext)s/mp4/")',
        'echo data > "$file"',
        'echo "TITLE Video de prueba"',
        'echo "FILE $file"',
      ].join("\n"),
    );
    chmodSync(script, 0o755);
    const work = target(`${name}-work`);
    const calls = () => readFileSync(path.join(d, "calls.log"), "utf8").trim().split("\n");
    return { script, work, calls };
  }

  it("descarga directo, una sola vez y sin proxy, hasta 1080p", async () => {
    const yt = fakeYtDlp("direct");
    const result = await downloadFromUrl("https://www.instagram.com/reel/abc/", yt.work, { ...options(), ytDlpPath: yt.script });
    expect(result.title).toBe("Video de prueba");
    expect(yt.calls()).toHaveLength(1);
    expect(yt.calls()[0]).toMatch(/^call proxy= sort=res:1080,fps,vcodec:h264,acodec:aac( |$)/);
  });

  it("«Guardar»: la calidad original, sin tope", async () => {
    const yt = fakeYtDlp("original");
    await downloadFromUrl("https://www.facebook.com/watch/?v=1", yt.work, { ...options(), ytDlpPath: yt.script, quality: "original" });
    expect(yt.calls()[0]).toMatch(/ sort=res,fps,vcodec:h264,acodec:aac( |$)/);
  });

  it("tramo elegido: baja solo ese tramo (sin el límite de duración del video entero)", async () => {
    const yt = fakeYtDlp("section");
    await downloadFromUrl("https://www.twitch.tv/videos/2885611944", yt.work, {
      ...options(),
      ytDlpPath: yt.script,
      section: { startSeconds: 5545.4, endSeconds: 7640.2 },
    });
    expect(yt.calls()[0]).toContain(" sections=*5545-7641");
    expect(yt.calls()[0]).toContain(" filter=!is_live");
    expect(yt.calls()[0]).not.toContain("duration");
    // Sin tramo: el video entero, con el límite de duración.
    const whole = fakeYtDlp("whole");
    await downloadFromUrl("https://www.twitch.tv/videos/2885611944", whole.work, { ...options(), ytDlpPath: whole.script });
    expect(whole.calls()[0]).not.toContain("sections=");
    expect(whole.calls()[0]).toMatch(/ filter=duration<=\?\d+&!is_live/);
  });

  it("Twitch: también baja hasta 1080p (60 fps si lo hay)", async () => {
    const yt = fakeYtDlp("twitch");
    await downloadFromUrl("https://www.twitch.tv/videos/2885611944", yt.work, { ...options(), ytDlpPath: yt.script });
    expect(yt.calls()[0]).toContain("sort=res:1080,fps,");
  });

  it("Kick: usa los complementos propios (códigos de video nuevos) y baja hasta 1080p", async () => {
    const yt = fakeYtDlp("kick");
    await downloadFromUrl("https://kick.com/punicher/videos/01a0b24f-2b40-7d20-b9d1-f1238dd1b2e7", yt.work, { ...options(), ytDlpPath: yt.script });
    const [direct] = yt.calls();
    expect(direct).toContain("sort=res:1080,fps,");
    expect(direct).toContain(` plugins=${YTDLP_PLUGINS_DIR}`);
    expect(existsSync(path.join(YTDLP_PLUGINS_DIR, "clipflow/yt_dlp_plugins/extractor/kick_video_page.py"))).toBe(true);
  });

  it("si la plataforma bloquea a nuestros servidores: un mensaje claro, sin reintentar, y el detalle sin contraseñas", async () => {
    const yt = fakeYtDlp("blocked", true);
    const error = await downloadFromUrl("https://www.instagram.com/reel/abc/", yt.work, { ...options(), ytDlpPath: yt.script }).catch((e) => e);
    expect(error).toBeInstanceOf(DownloadError);
    expect(error).toMatchObject({ retryable: false, blocked: true });
    expect(error.message).toMatch(/pide iniciar sesión/);
    expect(error.message).not.toMatch(/proxy/);
    expect(error.detail).toMatch(/login required/);
    expect(error.detail).not.toContain("clave");
    expect(yt.calls()).toHaveLength(1);
  });

  it("borra credenciales de los textos que van a los registros", () => {
    expect(redactCredentials("Unable to connect to http://user:clave@host.example.com:1000 (407)")).toBe("Unable to connect to http://***@host.example.com:1000 (407)");
  });

  it("restricción de edad, bloqueo por país e IP marcada tienen su propio mensaje", () => {
    // Visto con youtu.be/3nVF2EY_iHg (02/10/2026).
    const age = ytDlpErrorMessage("ERROR: [youtube] 3nVF2EY_iHg: Sign in to confirm your age. Use --cookies-from-browser or --cookies");
    expect(age.message).toMatch(/restricción de edad/);
    expect(age.blocked).toBeFalsy();
    const geo = ytDlpErrorMessage("ERROR: [youtube] x: Video unavailable. The uploader has not made this video available in your country");
    expect(geo).toMatchObject({ blocked: true });
    expect(geo.message).toMatch(/país/);
    const flagged = ytDlpErrorMessage("ERROR: [youtube] x: Video unavailable. This content isn’t available, try again later.");
    expect(flagged).toMatchObject({ blocked: true });
    expect(flagged.message).toMatch(/bloqueó la descarga/);
    // Un video borrado de verdad sigue diciendo que no existe.
    expect(ytDlpErrorMessage("ERROR: [youtube] x: Video unavailable. This video has been removed by the uploader").message).toMatch(/No encontramos/);
  });
});

describe("cuando yt-dlp no deja el archivo que anuncia", () => {
  function fakeSplit(name: string, parts: string[]) {
    const d = target(name);
    const script = path.join(d, "yt-dlp.sh");
    writeFileSync(
      script,
      [
        "#!/bin/sh",
        'out=""; prev=""',
        'for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done',
        'base=$(echo "$out" | sed "s/source.%(ext)s//")',
        ...parts.map((p) => `echo data > "${"$"}{base}${p}"`),
        'echo "FILE ${base}source.mp4"',
      ].join("\n"),
    );
    chmodSync(script, 0o755);
    return { script, work: target(`${name}-work`) };
  }

  it("video y audio sin unir: error claro que se reintenta (antes: ENOENT)", async () => {
    const yt = fakeSplit("split", ["source.f137.mp4", "source.f140.m4a"]);
    const error = await downloadFromUrl("https://www.instagram.com/reel/abc/", yt.work, { ...options(), ytDlpPath: yt.script }).catch((e) => e);
    expect(error).toBeInstanceOf(DownloadError);
    expect(error).toMatchObject({ retryable: true });
    expect(error.message).toMatch(/unir el video y el audio/);
  });

  it("si quedó un solo archivo con otro nombre, se usa ese", async () => {
    const yt = fakeSplit("single", ["source.webm"]);
    const result = await downloadFromUrl("https://www.facebook.com/watch?v=1", yt.work, { ...options(), ytDlpPath: yt.script });
    expect(path.basename(result.file)).toBe("source.webm");
  });
});
