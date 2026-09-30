import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface FfmpegTools {
  ffmpegPath: string;
  ffprobePath: string;
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly stderrTail: string,
  ) {
    super(message);
    this.name = "FfmpegError";
  }
}

interface RunOptions {
  cwd?: string;
  signal?: AbortSignal;
  /** Segundos procesados (según `-progress`), para calcular el progreso real. */
  onProgress?: (processedSeconds: number) => void;
}

/** Ejecuta un proceso y devuelve stdout. Se puede cancelar con `signal` (mata el proceso). */
function run(command: string, args: string[], options: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new DOMException("Cancelado", "AbortError"));
    const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      if (!options.onProgress) {
        stdout += text;
        return;
      }
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const match = line.match(/^out_time_us=(\d+)/);
        if (match) options.onProgress(Number(match[1]) / 1_000_000);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    const onAbort = () => child.kill("SIGKILL");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", onAbort);
      if (options.signal?.aborted) return reject(new DOMException("Cancelado", "AbortError"));
      if (code === 0) resolve(stdout);
      else reject(new FfmpegError(`${path.basename(command)} terminó con código ${code}`, stderr));
    });
  });
}

const FFMPEG_BASE = ["-hide_banner", "-nostdin", "-y", "-loglevel", "error"];

export interface ProbeResult {
  durationSeconds: number;
  width: number;
  height: number;
  hasAudio: boolean;
  videoCodec: string;
  raw: unknown;
}

/** Lee el contenido REAL del archivo. Lanza error si no es un video reproducible. */
export async function probe(tools: FfmpegTools, file: string): Promise<ProbeResult> {
  const out = await run(tools.ffprobePath, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
  const data = JSON.parse(out) as {
    format?: { duration?: string; format_name?: string };
    streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; duration?: string }[];
  };
  const video = data.streams?.find((s) => s.codec_type === "video" && s.width && s.height);
  const duration = Number(data.format?.duration ?? video?.duration);
  if (!video || !Number.isFinite(duration) || duration <= 0) {
    throw new FfmpegError("El archivo no contiene un video válido", "");
  }
  return {
    durationSeconds: duration,
    width: video.width!,
    height: video.height!,
    hasAudio: data.streams?.some((s) => s.codec_type === "audio") ?? false,
    videoCodec: video.codec_name ?? "desconocido",
    raw: { format: data.format, streams: data.streams },
  };
}

/**
 * Una sola pasada por el video para calcular dos señales por segundo:
 * - audio: volumen (RMS en dB) de cada segundo;
 * - visual: suma de "cambios de escena" en cada segundo.
 */
export async function analyzeSignals(
  tools: FfmpegTools,
  file: string,
  info: ProbeResult,
  workDir: string,
  options: { signal?: AbortSignal; onProgress?: (seconds: number) => void } = {},
): Promise<{ audio?: number[]; visual: number[] }> {
  const filters = [
    "[0:v:0]fps=4,scale=160:-2,select='gt(scene\\,0.3)',metadata=mode=print:file=scene.txt[v]",
  ];
  const outputs = ["-map", "[v]", "-f", "null", "-"];
  if (info.hasAudio) {
    filters.push(
      "[0:a:0]aresample=8000,asetnsamples=n=8000:p=0,astats=metadata=1:reset=1," +
        "ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=audio.txt[a]",
    );
    outputs.push("-map", "[a]", "-f", "null", "-");
  }
  await run(
    tools.ffmpegPath,
    [...FFMPEG_BASE, "-progress", "pipe:1", "-nostats", "-i", file, "-filter_complex", filters.join(";"), ...outputs],
    { cwd: workDir, ...options },
  );

  const seconds = Math.max(1, Math.floor(info.durationSeconds));
  const visual = new Array<number>(seconds).fill(0);
  for (const { time, value } of parseMetadataFile(await readFile(path.join(workDir, "scene.txt"), "utf8"), "lavfi.scene_score")) {
    const i = Math.min(seconds - 1, Math.floor(time));
    visual[i] = visual[i]! + value;
  }

  let audio: number[] | undefined;
  if (info.hasAudio) {
    audio = new Array<number>(seconds).fill(-120);
    const text = await readFile(path.join(workDir, "audio.txt"), "utf8");
    for (const { time, value } of parseMetadataFile(text, "lavfi.astats.Overall.RMS_level")) {
      const i = Math.floor(time);
      if (i < seconds) audio[i] = value;
    }
  }
  return { audio, visual };
}

/** Lee la salida de los filtros `metadata=print` / `ametadata=print`. */
export function parseMetadataFile(text: string, key: string): { time: number; value: number }[] {
  const result: { time: number; value: number }[] = [];
  let time: number | null = null;
  for (const line of text.split("\n")) {
    const frame = line.match(/pts_time:([\d.]+)/);
    if (frame) {
      time = Number(frame[1]);
      continue;
    }
    if (time !== null && line.startsWith(`${key}=`)) {
      const raw = line.slice(key.length + 1).trim();
      const value = raw === "-inf" ? -120 : Number(raw);
      if (Number.isFinite(value)) result.push({ time, value });
    }
  }
  return result;
}

/** Recorta un segmento y lo convierte a vertical 9:16 (1080x1920), listo para redes. */
export async function renderVerticalClip(
  tools: FfmpegTools,
  input: string,
  output: string,
  segment: { startSeconds: number; durationSeconds: number },
  options: { signal?: AbortSignal; onProgress?: (seconds: number) => void } = {},
): Promise<void> {
  await run(
    tools.ffmpegPath,
    [
      ...FFMPEG_BASE,
      "-progress",
      "pipe:1",
      "-nostats",
      "-ss",
      segment.startSeconds.toFixed(3),
      "-i",
      input,
      "-t",
      segment.durationSeconds.toFixed(3),
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-vf",
      "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ac",
      "2",
      "-movflags",
      "+faststart",
      output,
    ],
    options,
  );
}

/** Miniatura vertical (540x960) de un instante del video. */
export async function renderThumbnail(
  tools: FfmpegTools,
  input: string,
  output: string,
  atSeconds: number,
  signal?: AbortSignal,
): Promise<void> {
  await run(
    tools.ffmpegPath,
    [
      ...FFMPEG_BASE,
      "-ss",
      atSeconds.toFixed(3),
      "-i",
      input,
      "-frames:v",
      "1",
      "-vf",
      "scale=540:960:force_original_aspect_ratio=increase,crop=540:960",
      "-q:v",
      "4",
      output,
    ],
    { signal },
  );
}
