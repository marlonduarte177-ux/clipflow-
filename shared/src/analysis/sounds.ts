import type { SoundEvent, SoundKind, TranscriptSegment } from "./ai-provider.js";

/** Cómo se marca cada sonido en la transcripción que lee la IA. */
export const SOUND_MARKS: Record<SoundKind, string> = {
  laughter: "[risas]",
  scream: "[grito]",
  applause: "[aplausos]",
  cheer: "[vítores]",
};

/** Puntos extra (sobre 1) de un momento con risas o gritos, y con aplausos o vítores. Tope total. */
const STRONG_BONUS = 0.1;
const EXTRA_STRONG_BONUS = 0.05;
const CROWD_BONUS = 0.05;
const MAX_SOUND_BONUS = 0.15;

const fmt = (s: number) => s.toFixed(1);

/**
 * Transcripción para la IA con los sonidos marcados en su lugar: cada frase y cada sonido es una línea
 * `[inicio-fin] texto`, ordenadas por tiempo. Ej.: `[16.1-18.0] [risas]`.
 */
export function annotateTranscript(segments: TranscriptSegment[], sounds: SoundEvent[] = []): string {
  const lines = [
    ...segments.map((s) => ({ start: s.startSeconds, end: s.endSeconds, text: s.text, order: 0 })),
    ...sounds.map((e) => ({ start: e.startSeconds, end: e.endSeconds, text: SOUND_MARKS[e.kind], order: 1 })),
  ].sort((a, b) => a.start - b.start || a.order - b.order);
  return lines.map((l) => `[${fmt(l.start)}-${fmt(l.end)}] ${l.text}`).join("\n");
}

/** Señal "reaction" por segundo: la seguridad del sonido más fuerte en ese segundo (0 si no hay). */
export function reactionSignalFromSounds(events: SoundEvent[], durationSeconds: number): number[] {
  const seconds = Math.max(1, Math.floor(durationSeconds));
  const signal = new Array<number>(seconds).fill(0);
  for (const e of events) {
    const value = Math.min(1, Math.max(0, e.confidence));
    for (let i = Math.max(0, Math.floor(e.startSeconds)); i < Math.min(seconds, Math.ceil(e.endSeconds)); i++) {
      signal[i] = Math.max(signal[i]!, value);
    }
  }
  return signal;
}

/**
 * Puntos extra de un momento según sus sonidos: con risas o gritos +0,1 (+0,05 más si hay dos o más);
 * con aplausos o vítores +0,05. Como mucho +0,15.
 */
export function soundBonus(events: SoundEvent[], startSeconds: number, endSeconds: number): number {
  const inside = events.filter((e) => e.endSeconds > startSeconds && e.startSeconds < endSeconds);
  const strong = inside.filter((e) => e.kind === "laughter" || e.kind === "scream").length;
  const crowd = inside.some((e) => e.kind === "applause" || e.kind === "cheer");
  let bonus = 0;
  if (strong >= 1) bonus += STRONG_BONUS;
  if (strong >= 2) bonus += EXTRA_STRONG_BONUS;
  if (crowd) bonus += CROWD_BONUS;
  return Math.min(MAX_SOUND_BONUS, bonus);
}
