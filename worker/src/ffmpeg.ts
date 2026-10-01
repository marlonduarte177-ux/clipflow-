import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { analyzeFaces, FACE_SAMPLES_PER_SECOND } from "./faces/analyze.js";
import {
  buildTracks,
  chooseTargets,
  FRAMING,
  pathExpression,
  positionAt,
  smoothPath,
  toPieces,
  type PathPiece,
} from "./faces/framing.js";

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

/** Ejecuta FFmpeg y devuelve la salida binaria (p. ej. píxeles en crudo). */
function runRaw(command: string, args: string[], signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", reject);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) return reject(new DOMException("Cancelado", "AbortError"));
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new FfmpegError(`${path.basename(command)} terminó con código ${code}`, stderr));
    });
  });
}

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
    streams?: {
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      duration?: string;
      tags?: { rotate?: string };
      side_data_list?: { rotation?: number }[];
    }[];
  };
  const video = data.streams?.find((s) => s.codec_type === "video" && s.width && s.height);
  const duration = Number(data.format?.duration ?? video?.duration);
  if (!video || !Number.isFinite(duration) || duration <= 0) {
    throw new FfmpegError("El archivo no contiene un video válido", "");
  }
  // Videos de celular grabados en vertical suelen guardarse "acostados" con una marca de giro.
  // FFmpeg los gira al leerlos, así que las medidas reales son las del video ya girado.
  const rotation = Number(video.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? video.tags?.rotate ?? 0);
  const turned = Math.abs(Math.round(rotation)) % 180 === 90;
  return {
    durationSeconds: duration,
    width: turned ? video.height! : video.width!,
    height: turned ? video.width! : video.height!,
    hasAudio: data.streams?.some((s) => s.codec_type === "audio") ?? false,
    videoCodec: video.codec_name ?? "desconocido",
    raw: { format: data.format, streams: data.streams },
  };
}

/**
 * Una sola pasada por el video para calcular señales por segundo:
 * - audio: volumen promedio (dB) de cada segundo;
 * - action: picos de sonido cortos por segundo (disparos, golpes, explosiones, gritos),
 *   medidos cada 0.1 s contra el volumen de los 5 s anteriores;
 * - visual: movimiento y cambios de escena (suma de la puntuación de escena de FFmpeg).
 */
export async function analyzeSignals(
  tools: FfmpegTools,
  file: string,
  info: ProbeResult,
  workDir: string,
  options: { signal?: AbortSignal; onProgress?: (seconds: number) => void } = {},
): Promise<{ audio?: number[]; action?: number[]; visual: number[] }> {
  const filters = [
    "[0:v:0]fps=4,scale=160:-2,select='gte(scene\\,0)',metadata=mode=print:file=scene.txt[v]",
  ];
  const outputs = ["-map", "[v]", "-f", "null", "-"];
  if (info.hasAudio) {
    filters.push(
      // 800 muestras a 8 kHz = bloques de 0.1 s.
      "[0:a:0]aresample=8000,asetnsamples=n=800:p=0,astats=metadata=1:reset=1," +
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

  if (!info.hasAudio) return { visual };
  const blocks = parseMetadataFile(await readFile(path.join(workDir, "audio.txt"), "utf8"), "lavfi.astats.Overall.RMS_level");
  return { visual, ...audioSignals(blocks, seconds) };
}

/**
 * A partir del volumen cada 0.1 s: volumen promedio por segundo y cantidad de picos
 * (subidas bruscas de al menos 8 dB sobre la mediana de los 5 s anteriores).
 */
export function audioSignals(blocks: { time: number; value: number }[], seconds: number): { audio: number[]; action: number[] } {
  const power = new Array<number>(seconds).fill(0);
  const count = new Array<number>(seconds).fill(0);
  const action = new Array<number>(seconds).fill(0);
  const history: number[] = [];
  let previousWasPeak = false;
  for (const { time, value } of blocks) {
    const i = Math.floor(time);
    if (i >= seconds) continue;
    power[i] = power[i]! + 10 ** (value / 10);
    count[i] = count[i]! + 1;

    const sorted = [...history].sort((a, b) => a - b);
    const baseline = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : value;
    const isPeak = history.length >= 10 && value > -45 && value >= baseline + 8;
    if (isPeak && !previousWasPeak) action[i] = action[i]! + 1;
    previousWasPeak = isPeak;
    history.push(value);
    if (history.length > 50) history.shift();
  }
  const audio = power.map((p, i) => (count[i]! > 0 && p > 0 ? 10 * Math.log10(p / count[i]!) : -120));
  return { audio, action };
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

/** Zona del cuadro con imagen real (sin franjas negras). */
export interface ContentBox {
  width: number;
  height: number;
  x: number;
  y: number;
}

/**
 * Detecta franjas negras "quemadas" en el video (p. ej. un video horizontal subido a TikTok
 * en formato vertical). Toma varios fotogramas en baja resolución y marca como "imagen real"
 * las filas/columnas donde al menos un 35 % de los píxeles no son negros en algún fotograma.
 * Así una marca de agua pequeña dentro de la franja no cuenta como imagen.
 * Devuelve null si no hay franjas que quitar.
 */
export async function detectContentBox(
  tools: FfmpegTools,
  input: string,
  info: ProbeResult,
  signal?: AbortSignal,
): Promise<ContentBox | null> {
  const w = 160;
  const h = Math.max(2, Math.round((w * info.height) / info.width / 2) * 2);
  const samples = 8;
  const images: Buffer[] = [];
  for (let i = 0; i < samples; i++) {
    const at = (info.durationSeconds * (i + 0.5)) / samples;
    const pixels = await runRaw(
      tools.ffmpegPath,
      ["-hide_banner", "-nostdin", "-loglevel", "error", "-ss", at.toFixed(3), "-i", input,
        "-frames:v", "1", "-vf", `scale=${w}:${h},format=gray`, "-f", "rawvideo", "-"],
      signal,
    );
    if (pixels.length >= w * h) images.push(pixels);
  }
  if (images.length === 0) return null;

  const span = (values: Float64Array) => {
    let first = -1;
    let last = -1;
    values.forEach((v, i) => {
      if (v >= 0.35) {
        if (first < 0) first = i;
        last = i;
      }
    });
    if (first < 0) return null;
    // Un píxel hacia adentro en los bordes con franja: evita líneas negras por el redondeo.
    if (first > 0) first++;
    if (last < values.length - 1) last--;
    return last > first ? { first, last } : null;
  };
  // Primero las filas (franjas arriba/abajo)…
  const rowMax = new Float64Array(h);
  for (const px of images) {
    for (let y = 0; y < h; y++) {
      let bright = 0;
      for (let x = 0; x < w; x++) if (px[y * w + x]! > 32) bright++;
      rowMax[y] = Math.max(rowMax[y]!, bright / w);
    }
  }
  const rows = span(rowMax);
  if (!rows) return null;
  // …luego las columnas, mirando solo dentro de las filas con imagen (franjas laterales).
  const colMax = new Float64Array(w);
  const rowCount = rows.last + 1 - rows.first;
  for (const px of images) {
    for (let x = 0; x < w; x++) {
      let bright = 0;
      for (let y = rows.first; y <= rows.last; y++) if (px[y * w + x]! > 32) bright++;
      colMax[x] = Math.max(colMax[x]!, bright / rowCount);
    }
  }
  const cols = span(colMax);
  if (!cols) return null;

  const even = (n: number) => Math.max(0, Math.floor(n / 2) * 2);
  const sy = info.height / h;
  const sx = info.width / w;
  const box = {
    x: even(cols.first * sx),
    y: even(rows.first * sy),
    width: even((cols.last + 1 - cols.first) * sx),
    height: even((rows.last + 1 - rows.first) * sy),
  };
  box.width = Math.min(box.width, info.width - box.x);
  box.height = Math.min(box.height, info.height - box.y);
  // Solo vale la pena si quita al menos un 5 % y deja una imagen razonable.
  const removesSomething = box.width < info.width * 0.95 || box.height < info.height * 0.95;
  const sensible = box.width >= info.width * 0.2 && box.height >= info.height * 0.2;
  return removesSomething && sensible ? box : null;
}

/** Recorte final del cuadro original que se lleva a 1080x1920. */
export interface VerticalCrop {
  width: number;
  height: number;
  x: number;
  y: number;
  /** true: se muestra completo (sin recortar nada) y lo que falte se rellena de negro. */
  fit?: boolean;
  /** Filas con imagen real dentro del recorte; lo de arriba y abajo se pinta de negro (quita marcas de agua). */
  content?: { y: number; height: number };
  /** Posición horizontal que cambia en el tiempo (sigue caras). `x` es la del medio del clip. */
  path?: PathPiece[];
  /** "blur": el recorte se muestra entero y lo que falte del 9:16 se rellena con el mismo video difuminado. */
  fill?: "blur";
}

/**
 * Forma (ancho/alto) del recorte en videos horizontales. 9/16 sería pantalla completa (en un 16:9
 * solo queda ~31 % del ancho: se acerca mucho); 1 = cuadrado (~56 % del ancho), y arriba y abajo
 * se rellena con el mismo video difuminado.
 */
export const HORIZONTAL_WINDOW_ASPECT = 1;

/** Opciones del encuadre de cada clip. */
export interface CropOptions {
  /** Seguir caras (detector YuNet). Si no hay caras, se usa el encuadre por acción. */
  faces?: boolean;
  /** Si hay voz en el segundo t del clip (de la transcripción). */
  speaking?: (t: number) => boolean;
  /** Avisos que no detienen el trabajo (p. ej. el detector de caras falló). */
  onWarning?: (message: string, err: unknown) => void;
}

/** El mismo recorte, fijo en la posición del segundo t del clip (para la miniatura). */
export function cropAt(crop: VerticalCrop, t: number): VerticalCrop {
  if (!crop.path) return crop;
  const { path: pieces, ...rest } = crop;
  return { ...rest, x: Math.round(positionAt(pieces, t)) };
}

const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

/**
 * Cuánto se acerca un video vertical que trae una imagen horizontal con franjas negras.
 * 1.25 = la imagen se ve un 25 % más grande y se pierde un 10 % por cada lado.
 */
export const VERTICAL_BAND_ZOOM = 1.25;

/**
 * Encuadre vertical 9:16 de un clip. Solo se recorta cuando hace falta:
 * - Video horizontal: se quitan las franjas negras y se recorta un cuadrado (HORIZONTAL_WINDOW_ASPECT)
 *   donde está la acción o quien habla; arriba y abajo, el mismo video difuminado.
 * - Video vertical: NO se recorta. Si trae franjas laterales se quitan; si trae una imagen
 *   horizontal con franjas arriba/abajo, solo se acerca un poco (VERTICAL_BAND_ZOOM).
 * Devuelve el recorte exacto sobre el cuadro original.
 */
export async function chooseVerticalCrop(
  tools: FfmpegTools,
  input: string,
  info: ProbeResult,
  box: ContentBox | null,
  segment: { startSeconds: number; durationSeconds: number },
  signal?: AbortSignal,
  options: CropOptions = {},
): Promise<VerticalCrop> {
  const frame = { x: 0, y: 0, width: info.width, height: info.height };

  if (info.height > info.width) {
    // Vertical sin franjas, o con una imagen también vertical dentro: se muestra entera.
    if (!box || box.height >= box.width) return { ...(box ?? frame), fit: true };
    // Imagen horizontal dentro de un video vertical: acercar un poco, sin cortar de más.
    const zoom = Math.min(VERTICAL_BAND_ZOOM, info.height / box.height);
    if (zoom <= 1.02) return { ...frame, fit: true };
    const width = even(Math.min(info.width, box.width / zoom));
    const height = even(Math.min(info.height, (width * info.height) / info.width));
    const centerY = box.y + box.height / 2;
    const y = even(Math.min(info.height - height, Math.max(0, centerY - height / 2)));
    const offset = await bestWindow(tools, input, box, width, segment, signal);
    const top = Math.max(0, box.y - y);
    const content = { y: top, height: Math.min(height, box.y + box.height - y) - top };
    return { width, height, x: box.x + offset, y, fit: true, content };
  }

  // Horizontal: se recorta un poco (no a pantalla completa), donde está la acción o quien habla.
  const area = box ?? frame;
  const targetWidth = even(Math.min(area.width, area.height * HORIZONTAL_WINDOW_ASPECT));
  if (targetWidth >= area.width - 2) {
    // La imagen ya es tan angosta como el recorte: se muestra entera.
    return { width: even(area.width), height: even(area.height), x: area.x, y: area.y, fill: "blur" };
  }
  const action = async () => area.x + (await bestWindow(tools, input, area, targetWidth, segment, signal));
  if (options.faces) {
    try {
      const followed = await followFaces(tools, input, area, targetWidth, segment, action, signal, options.speaking);
      if (followed) return { ...followed, fill: "blur" };
    } catch (err) {
      if (signal?.aborted) throw err;
      options.onWarning?.("no se pudo seguir caras; se usa el encuadre por acción", err);
    }
  }
  return { width: targetWidth, height: even(area.height), x: await action(), y: area.y, fill: "blur" };
}

/**
 * Encuadre que sigue caras: a quien habla, o al grupo si cabe. Devuelve null si el clip no tiene
 * caras (se usa el encuadre por acción). Las escenas sin caras dentro del clip también usan ese
 * encuadre.
 */
async function followFaces(
  tools: FfmpegTools,
  input: string,
  area: ContentBox,
  targetWidth: number,
  segment: { startSeconds: number; durationSeconds: number },
  action: () => Promise<number>,
  signal?: AbortSignal,
  speaking?: (t: number) => boolean,
): Promise<VerticalCrop | null> {
  const analysis = await analyzeFaces(tools, input, area, segment, signal);
  const { samples, scale } = analysis;
  const dt = 1 / FACE_SAMPLES_PER_SECOND;
  const cropW = targetWidth / scale;
  const targets = chooseTargets(samples, buildTracks(samples), cropW, analysis.width, dt, speaking);
  if (targets.every((t) => t === null)) return null;
  const fallback = targets.some((t) => t === null) ? ((await action()) - area.x + targetWidth / 2) / scale : analysis.width / 2;
  const centers = smoothPath(samples, targets, cropW, analysis.width, dt, fallback);
  const maxX = area.x + area.width - targetWidth;
  const xs = centers.map((c) => Math.min(maxX, Math.max(area.x, area.x + c * scale - targetWidth / 2)));
  // Un cambio mayor que el paneo máximo entre dos muestras es un salto (persona o escena).
  const pieces = toPieces(samples.map((s) => s.t), xs, dt, FRAMING.maxSpeed * targetWidth * dt * 1.5);
  return {
    width: targetWidth,
    height: even(area.height),
    x: Math.round(positionAt(pieces, segment.durationSeconds / 2)),
    y: area.y,
    path: pieces,
  };
}

/** Desplazamiento horizontal (dentro de `area`) de la ventana de `targetWidth` con más acción. */
async function bestWindow(
  tools: FfmpegTools,
  input: string,
  area: ContentBox,
  targetWidth: number,
  segment: { startSeconds: number; durationSeconds: number },
  signal?: AbortSignal,
): Promise<number> {
  if (targetWidth >= area.width) return 0;
  const w = 160;
  const h = Math.max(2, Math.round((w * area.height) / area.width / 2) * 2);
  const frames: Buffer[] = [];
  const samples = 8;
  for (let i = 0; i < samples; i++) {
    const at = segment.startSeconds + (segment.durationSeconds * (i + 0.5)) / samples;
    const px = await runRaw(
      tools.ffmpegPath,
      ["-hide_banner", "-nostdin", "-loglevel", "error", "-ss", at.toFixed(3), "-i", input, "-frames:v", "1",
        "-vf", `crop=${area.width}:${area.height}:${area.x}:${area.y},scale=${w}:${h},format=gray`,
        "-f", "rawvideo", "-"],
      signal,
    );
    if (px.length >= w * h) frames.push(px);
  }

  // Interés por columna: detalle (bordes horizontales) + movimiento entre fotogramas seguidos.
  const interest = new Float64Array(w);
  frames.forEach((px, f) => {
    const prev = frames[f - 1];
    for (let y = 0; y < h; y++) {
      for (let x = 1; x < w; x++) {
        const i = y * w + x;
        interest[x] = interest[x]! + Math.abs(px[i]! - px[i - 1]!) + (prev ? 2 * Math.abs(px[i]! - prev[i]!) : 0);
      }
    }
  });
  const windowCols = Math.max(1, Math.round((targetWidth / area.width) * w));
  const maxStart = w - windowCols;
  const prefix = new Float64Array(w + 1);
  for (let x = 0; x < w; x++) prefix[x + 1] = prefix[x]! + interest[x]!;
  const center = maxStart / 2;
  let best = Math.round(center);
  let bestScore = -Infinity;
  for (let start = 0; start <= maxStart; start++) {
    const sum = prefix[start + windowCols]! - prefix[start]!;
    // Hasta un 15 % de preferencia por el centro: evita saltos por detalles sin importancia.
    const centerBias = maxStart > 0 ? 1 - 0.15 * (Math.abs(start - center) / center) : 1;
    const score = sum * centerBias;
    if (score > bestScore) {
      bestScore = score;
      best = start;
    }
  }
  return Math.min(area.width - targetWidth, even((best / w) * area.width));
}

/** Filtros de FFmpeg: recorte elegido → 1080x1920 (rellenando o mostrando completo). */
export function verticalFilter(crop: VerticalCrop | null): string {
  const x = crop?.path?.length ? `'${pathExpression(crop.path)}'` : crop?.x;
  let cut = crop ? `crop=${crop.width}:${crop.height}:${x}:${crop.y},` : "";
  if (crop?.content) {
    const { y, height } = crop.content;
    if (y > 0) cut += `drawbox=x=0:y=0:w=iw:h=${y}:color=black:t=fill,`;
    if (y + height < crop.height) cut += `drawbox=x=0:y=${y + height}:w=iw:h=${crop.height - y - height}:color=black:t=fill,`;
  }
  if (crop?.fill === "blur") {
    // Fondo: el mismo recorte, ampliado y muy difuminado (a baja resolución: rápido). Encima, el
    // recorte entero.
    return (
      `[0:v:0]${cut}split=2[fgsrc][bgsrc];` +
      "[bgsrc]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=12:2,scale=1080:1920,eq=brightness=-0.06[bg];" +
      "[fgsrc]scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2[fg];" +
      "[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[v]"
    );
  }
  const size = crop?.fit
    ? "scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black"
    : "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920";
  return `[0:v:0]${cut}${size},setsar=1[v]`;
}

/** Recorta un segmento y lo convierte a vertical 9:16 (1080x1920), listo para redes. */
export async function renderVerticalClip(
  tools: FfmpegTools,
  input: string,
  output: string,
  segment: { startSeconds: number; durationSeconds: number },
  options: {
    signal?: AbortSignal;
    onProgress?: (seconds: number) => void;
    crop?: VerticalCrop | null;
    /** Subtítulos a quemar: archivo ASS (tiempos relativos al clip) y carpeta de fuentes. */
    subtitles?: { file: string; fontsDir: string };
  } = {},
): Promise<void> {
  let filter = verticalFilter(options.crop ?? null);
  if (options.subtitles) {
    // Se dibujan sobre el 1080x1920 final. Rutas entre comillas: pueden tener ":".
    const quote = (p: string) => `'${p.replace(/'/g, "")}'`;
    filter =
      filter.replace(/\[v\]$/, "[vbase]") +
      `;[vbase]ass=filename=${quote(options.subtitles.file)}:fontsdir=${quote(options.subtitles.fontsDir)}[v]`;
  }
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
      "-filter_complex",
      filter,
      "-map",
      "[v]",
      "-map",
      "0:a:0?",
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
    { signal: options.signal, onProgress: options.onProgress },
  );
}

/** Miniatura vertical (540x960) de un instante del video. */
export async function renderThumbnail(
  tools: FfmpegTools,
  input: string,
  output: string,
  atSeconds: number,
  signal?: AbortSignal,
  crop: VerticalCrop | null = null,
): Promise<void> {
  await run(
    tools.ffmpegPath,
    [
      ...FFMPEG_BASE,
      "-ss",
      atSeconds.toFixed(3),
      "-i",
      input,
      "-filter_complex",
      `${verticalFilter(crop)};[v]scale=540:960[t]`,
      "-map",
      "[t]",
      "-frames:v",
      "1",
      "-q:v",
      "4",
      output,
    ],
    { signal },
  );
}

/**
 * Extrae solo el audio (mono, 16 kHz, MP3 32 kbps ≈ 14 MB por hora) en trozos de
 * `chunkSeconds`, cada uno muy por debajo del límite de 25 MB de OpenAI.
 */
export async function extractAudioChunks(
  tools: FfmpegTools,
  input: string,
  workDir: string,
  options: { maxSeconds: number; chunkSeconds?: number; signal?: AbortSignal },
): Promise<{ path: string; offsetSeconds: number; durationSeconds: number }[]> {
  const { readdir } = await import("node:fs/promises");
  await run(
    tools.ffmpegPath,
    [
      ...FFMPEG_BASE,
      "-i",
      input,
      "-t",
      options.maxSeconds.toFixed(3),
      "-map",
      "0:a:0",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "32k",
      "-f",
      "segment",
      "-segment_time",
      String(options.chunkSeconds ?? 600),
      "-reset_timestamps",
      "1",
      "audio-%03d.mp3",
    ],
    { cwd: workDir, signal: options.signal },
  );
  const files = (await readdir(workDir)).filter((f) => /^audio-\d{3}\.mp3$/.test(f)).sort();
  const chunks = [];
  let offset = 0;
  for (const file of files) {
    const full = path.join(workDir, file);
    const out = await run(tools.ffprobePath, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", full]);
    const duration = Number(out.trim());
    if (!Number.isFinite(duration) || duration <= 0.5) continue;
    chunks.push({ path: full, offsetSeconds: offset, durationSeconds: duration });
    offset += duration;
  }
  return chunks;
}

/**
 * Hojas de fotogramas para el análisis de imágenes con IA: 1 fotograma cada `intervalSeconds`
 * (sin franjas negras), agrupados en cuadrículas de columnas×filas. Una hoja = una imagen para
 * la IA, así se paga una imagen por cada 9 fotogramas en lugar de 9.
 */
export async function buildFrameSheets(
  tools: FfmpegTools,
  input: string,
  workDir: string,
  info: ProbeResult,
  options: {
    intervalSeconds: number;
    box: ContentBox | null;
    columns?: number;
    rows?: number;
    tileWidth?: number;
    tileHeight?: number;
    signal?: AbortSignal;
    onProgress?: (seconds: number) => void;
  },
): Promise<{ path: string; frameTimes: number[]; columns: number; rows: number }[]> {
  const { readdir } = await import("node:fs/promises");
  const columns = options.columns ?? 3;
  const rows = options.rows ?? 3;
  const tw = options.tileWidth ?? 512;
  const th = options.tileHeight ?? 288;
  const crop = options.box ? `crop=${options.box.width}:${options.box.height}:${options.box.x}:${options.box.y},` : "";
  await run(
    tools.ffmpegPath,
    [
      ...FFMPEG_BASE, "-progress", "pipe:1", "-nostats", "-i", input, "-an",
      "-vf",
      `${crop}fps=1/${options.intervalSeconds},scale=${tw}:${th}:force_original_aspect_ratio=decrease,` +
        `pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2,tile=${columns}x${rows}`,
      "-q:v", "4", "sheet-%04d.jpg",
    ],
    { cwd: workDir, signal: options.signal, onProgress: options.onProgress },
  );
  const files = (await readdir(workDir)).filter((f) => /^sheet-\d{4}\.jpg$/.test(f)).sort();
  const perSheet = columns * rows;
  // El filtro fps toma un fotograma a mitad de cada intervalo: 1.5 s, 4.5 s, 7.5 s… (con 3 s).
  const totalFrames = Math.max(1, Math.floor(info.durationSeconds / options.intervalSeconds));
  return files.map((file, k) => {
    const first = k * perSheet;
    const count = Math.max(0, Math.min(perSheet, totalFrames - first));
    return {
      path: path.join(workDir, file),
      frameTimes: Array.from({ length: count }, (_, i) => (first + i + 0.5) * options.intervalSeconds),
      columns,
      rows,
    };
  }).filter((s) => s.frameTimes.length > 0);
}
