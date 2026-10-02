import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DownloadError,
  downloadFromUrl,
  downloadWithYtDlp,
  isPlatformUrl,
  redactCredentials,
  withStickySession,
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

describe("proxy residencial para plataformas que bloquean a AWS", () => {
  /**
   * yt-dlp falso: sin --proxy responde como YouTube a un servidor de nube ("not a bot"); con
   * --proxy "descarga" y anota la URL del proxy que recibió.
   */
  function fakeYtDlp(name: string) {
    const d = target(name);
    const script = path.join(d, "yt-dlp.sh");
    writeFileSync(
      script,
      [
        "#!/bin/sh",
        'out=""; proxy=""; sort=""; prev=""',
        'for a in "$@"; do',
        '  [ "$prev" = "-o" ] && out="$a"',
        '  [ "$prev" = "--proxy" ] && proxy="$a"',
        '  [ "$prev" = "-S" ] && sort="$a"',
        '  prev="$a"',
        "done",
        'echo "call proxy=$proxy sort=$sort" >> "$(dirname "$0")/calls.log"',
        'if [ -z "$proxy" ]; then echo "ERROR: [youtube] x: Sign in to confirm you are not a bot" >&2; exit 1; fi',
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

  it("YouTube va directo por el proxy, con sesión fija y hasta 720p", async () => {
    const yt = fakeYtDlp("proxy-youtube");
    const result = await downloadFromUrl("https://youtu.be/abc", yt.work, {
      ...options(),
      ytDlpPath: yt.script,
      proxyUrl: "http://user:secreto@rp.evomi.com:1000",
    });
    expect(result).toMatchObject({ title: "Video de prueba", sizeBytes: 5 });
    const calls = yt.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/proxy=http:\/\/user:secreto_country-US_session-[A-Za-z0-9]{8}_lifetime-60@rp\.evomi\.com:1000/);
    expect(calls[0]).toContain("sort=res:720,");
  });

  it("otras plataformas: primero sin proxy (gratis) y, si las bloquean, una vez por el proxy", async () => {
    const yt = fakeYtDlp("proxy-fallback");
    const result = await downloadFromUrl("https://www.instagram.com/reel/abc/", yt.work, {
      ...options(),
      ytDlpPath: yt.script,
      proxyUrl: "http://user:secreto@rp.evomi.com:1000",
    });
    expect(result.title).toBe("Video de prueba");
    const calls = yt.calls();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe("call proxy= sort=res:1080,vcodec:h264,acodec:aac");
    expect(calls[1]).toMatch(/proxy=http:\/\/user:secreto_country-US_session-/);
  });

  it("si el proxy está mal escrito y nos bloquean, el mensaje lo dice", async () => {
    const yt = fakeYtDlp("proxy-bad");
    const error = await downloadFromUrl("https://youtu.be/abc", yt.work, {
      ...options(),
      ytDlpPath: yt.script,
      proxyProblem: "mal escrito",
    }).catch((e) => e);
    expect(error.message).toMatch(/bloqueó la descarga.*\(proxy: mal escrito\)$/);
  });

  it("sin proxy configurado se comporta como antes, y el detalle del error no lleva contraseñas", async () => {
    const yt = fakeYtDlp("proxy-off");
    const error = await downloadFromUrl("https://youtu.be/abc", yt.work, { ...options(), ytDlpPath: yt.script }).catch((e) => e);
    expect(error).toBeInstanceOf(DownloadError);
    expect(error).toMatchObject({ retryable: false, blocked: true });
    expect(error.message).toMatch(/bloqueó la descarga/);
    expect(error.detail).toMatch(/not a bot/);
    expect(yt.calls()).toHaveLength(1);
  });

  it("Evomi: país fijo y sesión fija, sin duplicar lo que ya trae la contraseña", () => {
    expect(withStickySession("http://u:p@rp.evomi.com:1000")).toMatch(
      /^http:\/\/u:p_country-US_session-[A-Za-z0-9]{8}_lifetime-60@rp\.evomi\.com:1000\/?$/,
    );
    expect(withStickySession("http://u:p_country-MX_session-abcdefgh@rp.evomi.com:1000")).toBe("http://u:p_country-MX_session-abcdefgh@rp.evomi.com:1000/");
    expect(withStickySession("http://u:p@proxy.example.com:8080")).toBe("http://u:p@proxy.example.com:8080/");
  });

  it("borra credenciales de los textos que van a los registros", () => {
    expect(redactCredentials("Unable to connect to proxy http://user:clave_session-x@rp.evomi.com:1000 (407)")).toBe(
      "Unable to connect to proxy http://***@rp.evomi.com:1000 (407)",
    );
  });

  it("los fallos del propio proxy se reintentan y no se confunden con un bloqueo", () => {
    // Credenciales mal puestas: la app dice el motivo y no se reintenta en vano.
    const badAuth = ytDlpErrorMessage("ERROR: Unable to download webpage: ('Unable to connect to proxy', OSError('Tunnel connection failed: 407 Proxy Authentication Required'))");
    expect(badAuth).toMatchObject({ retryable: false });
    expect(badAuth.message).toContain("(proxy: usuario o contraseña incorrectos, 407)");
    expect(badAuth.blocked).toBeFalsy();
    // Mismo error con curl (el modo que imita a un navegador).
    expect(ytDlpErrorMessage("ERROR: [youtube] x: curl: (56) CONNECT tunnel failed, response 407").message).toContain("407");
    expect(ytDlpErrorMessage("ERROR: curl: (56) CONNECT tunnel failed, response 402").message).toContain("sin saldo");
    const down = ytDlpErrorMessage("ERROR: curl: (7) Failed to connect to proxy rp.evomi.com port 1000 after 30001 ms: Timeout was reached");
    expect(down).toMatchObject({ retryable: true });
    expect(down.message).toContain("tiempo de espera agotado");
    expect(ytDlpErrorMessage("ERROR: [instagram] x: Requested content is not available, rate-limit reached or login required").blocked).toBe(true);
  });

  it("YouTube: restricción de edad, bloqueo por país e IP marcada tienen su propio mensaje", () => {
    // Visto con youtu.be/3nVF2EY_iHg (02/10/2026): el proxy no lo arregla, no se reintenta por él.
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
