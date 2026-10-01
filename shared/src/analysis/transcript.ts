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
  options: { maxShiftSeconds?: number; videoDurationSeconds: number },
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

  const start = Math.max(0, nearest(moment.startSeconds, starts) ?? moment.startSeconds);
  const end = Math.min(options.videoDurationSeconds, nearest(moment.endSeconds, ends) ?? moment.endSeconds);
  if (end - start < 3) return moment; // ajuste absurdo: se deja como estaba
  return { ...moment, startSeconds: round3(start), endSeconds: round3(end) };
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
