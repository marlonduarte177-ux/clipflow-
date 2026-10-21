import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ClipEditData } from "@clipflow/shared";
import { crfFor, FFMPEG_BASE, HD_AFTER_SCALE, HD_BEFORE_SCALE, parseMetadataFile, run, type FfmpegTools } from "./ffmpeg.js";

/**
 * Modo viral: el clip limpio (1080x1920, sin subtítulos) con subtítulos karaoke, zoom tipo «golpe»,
 * temblor y flash en los momentos fuertes, música de fondo opcional y salida a 60 fps.
 */

/** Un momento fuerte del clip y qué efectos lleva. */
export interface ActionMoment {
  atSeconds: number;
  /** 0–1: qué tan fuerte es (decide temblor y flash). */
  strength: number;
  zoom: boolean;
  shake: boolean;
  flash: boolean;
}

/** Volumen cada 0.1 s (dB RMS) del audio del clip. */
export async function measureLoudness(
  tools: FfmpegTools,
  file: string,
  workDir: string,
  signal?: AbortSignal,
): Promise<{ time: number; value: number }[]> {
  const out = path.join(workDir, "loudness.txt");
  await run(
    tools.ffmpegPath,
    [
      ...FFMPEG_BASE,
      "-i",
      file,
      "-vn",
      "-af",
      // 800 muestras a 8 kHz = bloques de 0.1 s (como el análisis de señales).
      `aresample=8000,asetnsamples=n=800:p=0,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=${path.basename(out)}`,
      "-f",
      "null",
      "-",
    ],
    { cwd: workDir, signal },
  );
  return parseMetadataFile(await readFile(out, "utf8"), "lavfi.astats.Overall.RMS_level");
}

/** Sonidos que piden efecto (los que detecta el procesador al analizar el video). */
const LOUD_SOUNDS = new Set(["scream", "laughter", "cheer", "applause"]);
/** Entre dos golpes, al menos esto (si no, se ve exagerado). */
const MIN_GAP_SECONDS = 2.6;

/**
 * Elige los momentos fuertes: picos de volumen (al menos 6 dB sobre el nivel normal del clip) y los
 * sonidos detectados (gritos, risas, vítores). Siempre hay un golpe suave al inicio (el «gancho»).
 */
export function pickActionMoments(
  durationSeconds: number,
  loudness: { time: number; value: number }[],
  sounds: ClipEditData["sounds"] = [],
): ActionMoment[] {
  const values = loudness.filter((b) => b.value > -90).map((b) => b.value).sort((a, b) => a - b);
  const median = values.length ? values[Math.floor(values.length / 2)]! : -30;
  const candidates: { at: number; score: number }[] = [];
  for (let i = 1; i < loudness.length - 1; i++) {
    const b = loudness[i]!;
    const isTop = b.value >= loudness[i - 1]!.value && b.value >= loudness[i + 1]!.value;
    if (isTop && b.value > -40 && b.value >= median + 6) candidates.push({ at: b.time, score: (b.value - median) / 18 });
  }
  for (const s of sounds) {
    if (LOUD_SOUNDS.has(s.kind) && s.confidence >= 0.4) candidates.push({ at: s.startSeconds, score: 0.6 + s.confidence * 0.6 });
  }
  const usable = candidates
    .filter((c) => c.at >= 0.6 && c.at <= durationSeconds - 0.8)
    .sort((a, b) => b.score - a.score);
  const max = Math.max(1, Math.min(6, Math.round(durationSeconds / 7)));
  const chosen: { at: number; score: number }[] = [];
  for (const c of usable) {
    if (chosen.length >= max) break;
    if (chosen.every((x) => Math.abs(x.at - c.at) >= MIN_GAP_SECONDS)) chosen.push(c);
  }
  const top = Math.max(1, ...chosen.map((c) => c.score));
  const moments: ActionMoment[] = chosen
    .map((c, rank) => {
      const strength = Math.min(1, c.score / top);
      return { atSeconds: round(c.at), strength: round(strength), zoom: true, shake: strength >= 0.55, flash: rank < 2 && strength >= 0.7 };
    })
    .sort((a, b) => a.atSeconds - b.atSeconds);
  // Gancho: un golpe de zoom suave apenas empieza (sin temblor ni flash).
  if (!moments.some((m) => m.atSeconds < MIN_GAP_SECONDS)) {
    moments.unshift({ atSeconds: 0.05, strength: 0.5, zoom: true, shake: false, flash: false });
  }
  return moments;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Duración de cada efecto (s) y su fuerza máxima. */
const ZOOM_SECONDS = 0.38;
const ZOOM_AMOUNT = 0.16;
const SHAKE_SECONDS = 0.32;
const SHAKE_PX = 18;
const FLASH_SECONDS = 0.09;
const FLASH_BRIGHTNESS = 0.32;

/** Suma de «pulsos» que bajan de 1 a 0 en `length` segundos desde cada momento (variable de tiempo `v`). */
function pulses(times: number[], length: number, v: string): string {
  if (times.length === 0) return "0";
  return times.map((t) => `between(${v},${t},${round(t + length)})*(1-(${v}-${t})/${length})`).join("+");
}

/**
 * Filtros de video del modo viral sobre el clip limpio de 1080x1920: 60 fps, zoom golpe y temblor
 * (zoompan sobre el tiempo de cada fotograma), flash (brillo) y, encima, los subtítulos karaoke.
 */
export function viralVideoFilter(
  moments: ActionMoment[],
  subtitles?: { file: string; fontsDir: string },
  /** Calidad HD para un clip limpio que no la tenía (clips anteriores): mejora antes de los efectos. */
  enhance = false,
): string {
  const zoom = pulses(moments.filter((m) => m.zoom).map((m) => m.atSeconds), ZOOM_SECONDS, "it");
  const shake = pulses(moments.filter((m) => m.shake).map((m) => m.atSeconds), SHAKE_SECONDS, "it");
  const flash = pulses(moments.filter((m) => m.flash).map((m) => m.atSeconds), FLASH_SECONDS, "t");
  const parts = [
    `[0:v:0]${enhance ? `${HD_BEFORE_SCALE}${HD_AFTER_SCALE}` : ""}fps=60`,
    `zoompan=z='1+${ZOOM_AMOUNT}*(${zoom})'` +
      `:x='iw/2-iw/zoom/2+${SHAKE_PX}*(${shake})*sin(it*71)'` +
      `:y='ih/2-ih/zoom/2+${SHAKE_PX}*(${shake})*cos(it*89)'` +
      ":d=1:s=1080x1920:fps=60",
  ];
  if (flash !== "0") parts.push(`eq=brightness='${FLASH_BRIGHTNESS}*(${flash})':eval=frame`);
  parts.push("setsar=1");
  let filter = parts.join(",");
  if (subtitles) {
    const quote = (p: string) => `'${p.replace(/'/g, "")}'`;
    filter += `,ass=filename=${quote(subtitles.file)}:fontsdir=${quote(subtitles.fontsDir)}`;
  }
  return `${filter}[v]`;
}

/** Volumen de la música de fondo (la voz del clip se mantiene). */
export const MUSIC_VOLUME = 0.12;

/** Genera el clip viral. `music`: archivo de audio (se repite si es corto). */
export async function renderViralClip(
  tools: FfmpegTools,
  input: string,
  output: string,
  options: {
    durationSeconds: number;
    hasAudio: boolean;
    moments: ActionMoment[];
    subtitles?: { file: string; fontsDir: string };
    music?: string;
    /** Calidad HD: CRF 18 (el clip limpio normalmente ya viene mejorado). */
    hd?: boolean;
    /** Además mejorar la imagen (clip limpio hecho sin calidad HD). */
    enhance?: boolean;
    signal?: AbortSignal;
    onProgress?: (seconds: number) => void;
  },
): Promise<void> {
  const d = options.durationSeconds.toFixed(3);
  const filters = [viralVideoFilter(options.moments, options.subtitles, options.enhance)];
  const inputs = ["-i", input];
  let audioMap = options.hasAudio ? ["-map", "0:a:0"] : [];
  if (options.music) {
    inputs.push("-stream_loop", "-1", "-i", options.music);
    const fadeOut = Math.max(0, options.durationSeconds - 1.2).toFixed(3);
    const music = `[1:a:0]atrim=0:${d},asetpts=N/SR/TB,volume=${MUSIC_VOLUME},afade=t=in:d=0.6,afade=t=out:st=${fadeOut}:d=1.2`;
    filters.push(
      options.hasAudio
        ? `${music}[m];[0:a:0][m]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]`
        : `${music}[a]`,
    );
    audioMap = ["-map", "[a]"];
  }
  await run(
    tools.ffmpegPath,
    [
      ...FFMPEG_BASE,
      "-progress",
      "pipe:1",
      "-nostats",
      ...inputs,
      "-filter_complex",
      filters.join(";"),
      "-map",
      "[v]",
      ...audioMap,
      "-t",
      d,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      crfFor(options.hd),
      "-r",
      "60",
      "-g",
      "120",
      "-pix_fmt",
      "yuv420p",
      ...(audioMap.length ? ["-c:a", "aac", "-b:a", "160k", "-ac", "2"] : []),
      "-movflags",
      "+faststart",
      output,
    ],
    { signal: options.signal, onProgress: options.onProgress },
  );
}
