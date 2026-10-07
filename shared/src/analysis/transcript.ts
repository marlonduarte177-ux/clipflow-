import type { ContentHighlight, FrameScore, TranscriptSegment } from "./ai-provider.js";
import type { Moment } from "./scoring.js";

/**
 * Señal "speech" por segundo a partir de los momentos que marcó la IA:
 * cada segundo vale la fuerza del mejor momento que lo cubre (0 si ninguno).
 */
export function speechSignalFromHighlights(highlights: ContentHighlight[], durationSeconds: number): number[] {
  const seconds = Math.max(1, Math.floor(durationSeconds));
  const signal = new Array<number>(seconds).fill(0);
  for (const h of highlights) {
    const strength = Math.min(1, Math.max(0, h.strength));
    for (let i = Math.max(0, Math.floor(h.startSeconds)); i < Math.min(seconds, Math.ceil(h.endSeconds)); i++) {
      signal[i] = Math.max(signal[i]!, strength);
    }
  }
  return signal;
}

/**
 * Ajusta el inicio y el fin de un clip a los bordes de frase más cercanos, para no cortar
 * a mitad de una idea. Nunca mueve un borde más de `maxShiftSeconds`.
 */
export function snapToSentences(
  moment: Moment,
  segments: TranscriptSegment[],
  options: {
    maxShiftSeconds?: number;
    videoDurationSeconds: number;
    /** Solo hacia afuera: empieza en la frase de antes y termina en la de después (no recorta la idea). */
    outward?: boolean;
  },
): Moment {
  const maxShift = options.maxShiftSeconds ?? 4;
  if (segments.length === 0) return moment;
  const starts = segments.map((s) => s.startSeconds);
  const ends = segments.map((s) => s.endSeconds);
  const nearest = (target: number, candidates: number[]) =>
    candidates.reduce<number | null>((best, c) => {
      if (Math.abs(c - target) > maxShift) return best;
      return best === null || Math.abs(c - target) < Math.abs(best - target) ? c : best;
    }, null);

  const outwardStart = (target: number) => nearest(target, starts.filter((s) => s <= target + 0.25));
  const outwardEnd = (target: number) => nearest(target, ends.filter((e) => e >= target - 0.25));
  const start = Math.max(
    0,
    (options.outward ? outwardStart(moment.startSeconds) : null) ?? nearest(moment.startSeconds, starts) ?? moment.startSeconds,
  );
  const end = Math.min(
    options.videoDurationSeconds,
    (options.outward ? outwardEnd(moment.endSeconds) : null) ?? nearest(moment.endSeconds, ends) ?? moment.endSeconds,
  );
  if (end - start < 3) return moment; // ajuste absurdo: se deja como estaba
  return { ...moment, startSeconds: round3(start), endSeconds: round3(end) };
}

/** Largo obligatorio de un clip según la duración que eligió el usuario: ±5 s. Ej.: 60 s → entre 55 y 65 s. */
export function clipDurationRange(clipDurationSeconds: number): { min: number; max: number } {
  return { min: Math.max(1, clipDurationSeconds - 5), max: clipDurationSeconds + 5 };
}

/**
 * Lleva un momento al largo obligatorio cortando en frases completas: empieza al inicio de una frase
 * (la del momento o una cercana) y termina al final de una frase, con el largo dentro de [min, max].
 * Si el momento es corto, se alarga con las frases que siguen (o las de antes); si es largo, se recorta
 * en el final de frase más cercano. Devuelve null si no hay ningún corte en frases que dé ese largo.
 */
export function fitToSentences(
  startSeconds: number,
  endSeconds: number,
  segments: TranscriptSegment[],
  options: { min: number; max: number; videoDurationSeconds: number },
): { startSeconds: number; endSeconds: number } | null {
  const spoken = segments.filter((s) => s.text.trim() !== "" && s.endSeconds > s.startSeconds);
  if (spoken.length === 0) return null;
  const { min, max } = options;
  const starts = [...new Set(spoken.map((s) => s.startSeconds))].sort((a, b) => a - b);
  const ends = [...new Set(spoken.map((s) => s.endSeconds))].filter((e) => e <= options.videoDurationSeconds + 0.25);
  // Preferido: la frase donde arranca el momento (o la que empieza justo antes, hasta 4 s).
  const own = starts.filter((x) => x <= startSeconds + 0.25 && x >= startSeconds - 4).pop();
  // Si no alcanza, otros inicios de frase cerca, sin perder la idea: hasta medio clip antes o hasta la mitad del momento.
  const nearby = starts
    .filter((x) => x >= startSeconds - max / 2 && x <= startSeconds + Math.max(0, (endSeconds - startSeconds) / 2))
    .sort((a, b) => Math.abs(a - startSeconds) - Math.abs(b - startSeconds));
  for (const start of [...(own !== undefined ? [own] : []), ...nearby]) {
    // Final ideal: el que eligió la IA si ya da un largo permitido; si no, el largo pedido (centro del rango).
    const length = endSeconds - start;
    const ideal = length >= min && length <= max ? endSeconds : start + (min + max) / 2;
    // Se prefiere el primer final de frase desde ese punto (no corta la idea); si no hay, el más cercano antes.
    const allowed = ends.filter((end) => end - start >= min && end - start <= max).sort((x, y) => x - y);
    const best = allowed.find((end) => end >= ideal - 0.25) ?? allowed[allowed.length - 1] ?? null;
    if (best !== null) return { startSeconds: round3(start), endSeconds: round3(Math.min(best, options.videoDurationSeconds)) };
  }
  return null;
}

/**
 * Sin frases donde cortar (sin habla): se alarga o recorta el momento al rango, sin salirse del video.
 * Si el video es más corto que el mínimo, el clip es el video entero.
 */
export function clampToRange(
  startSeconds: number,
  endSeconds: number,
  options: { min: number; max: number; videoDurationSeconds: number },
): { startSeconds: number; endSeconds: number } {
  const length = Math.min(options.videoDurationSeconds, Math.min(options.max, Math.max(options.min, endSeconds - startSeconds)));
  const start = Math.max(0, Math.min(startSeconds, options.videoDurationSeconds - length));
  return { startSeconds: round3(start), endSeconds: round3(start + length) };
}

/** Frases de un tramo, con tiempos relativos al inicio del tramo (para subtítulos de un clip). */
export function segmentsForRange(segments: TranscriptSegment[], startSeconds: number, endSeconds: number): TranscriptSegment[] {
  return segments
    .filter((s) => s.endSeconds > startSeconds && s.startSeconds < endSeconds && s.text.trim() !== "")
    .map((s) => {
      const out: TranscriptSegment = {
        startSeconds: round3(Math.max(0, s.startSeconds - startSeconds)),
        endSeconds: round3(Math.min(endSeconds, s.endSeconds) - startSeconds),
        text: s.text.trim(),
      };
      const words = s.words
        ?.filter((w) => w.endSeconds > startSeconds && w.startSeconds < endSeconds && w.text.trim() !== "")
        .map((w) => ({
          startSeconds: round3(Math.max(0, w.startSeconds - startSeconds)),
          endSeconds: round3(Math.min(endSeconds, w.endSeconds) - startSeconds),
          text: w.text.trim(),
        }));
      if (words?.length) out.words = words;
      return out;
    });
}

function timestamp(seconds: number, separator: "," | "."): string {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const rest = ms % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad(rest, 3)}`;
}

/** Subtítulos en formato SubRip (.srt). */
export function toSrt(segments: TranscriptSegment[]): string {
  return segments
    .map((s, i) => `${i + 1}\n${timestamp(s.startSeconds, ",")} --> ${timestamp(s.endSeconds, ",")}\n${s.text}\n`)
    .join("\n");
}

/** Subtítulos en formato WebVTT (.vtt), el que usan los navegadores. */
export function toVtt(segments: TranscriptSegment[]): string {
  const body = segments
    .map((s) => `${timestamp(s.startSeconds, ".")} --> ${timestamp(s.endSeconds, ".")}\n${s.text.replace(/-->/g, "→")}\n`)
    .join("\n");
  return `WEBVTT\n\n${body}`;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Señal "vision" por segundo: cada fotograma puntuado cubre hasta el siguiente. */
export function visionSignalFromFrames(frames: FrameScore[], durationSeconds: number, intervalSeconds: number): number[] {
  const seconds = Math.max(1, Math.floor(durationSeconds));
  const signal = new Array<number>(seconds).fill(0);
  for (const f of frames) {
    const score = Math.min(1, Math.max(0, f.score));
    // Cada fotograma representa el tramo [t - intervalo/2, t + intervalo/2).
    const from = Math.max(0, Math.round(f.timeSeconds - intervalSeconds / 2));
    const to = Math.min(seconds, Math.round(f.timeSeconds + intervalSeconds / 2));
    for (let i = from; i < to; i++) signal[i] = Math.max(signal[i]!, score);
  }
  return signal;
}

/** Etiqueta del fotograma mejor puntuado dentro de un tramo (sirve de título sin voz). */
export function bestFrameLabel(frames: FrameScore[], startSeconds: number, endSeconds: number): string | null {
  let best: FrameScore | null = null;
  for (const f of frames) {
    if (f.timeSeconds < startSeconds || f.timeSeconds > endSeconds || !f.label.trim()) continue;
    if (!best || f.score > best.score) best = f;
  }
  return best && best.score >= 0.5 ? best.label.trim().slice(0, 80) : null;
}
