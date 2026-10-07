import type { ScoreWeights } from "../product-config.js";
import type { ContentHighlight, TranscriptSegment } from "./ai-provider.js";
import { clampToRange, clipDurationRange, fitToSentences } from "./transcript.js";
import { normalizeSeries, selectMoments, SIGNAL_MIN_RANGE, type Moment, type SignalName, type SignalSeries } from "./scoring.js";

/** Fuerza mínima (0–1) que la IA le dio a un momento para que sea clip. */
export const AI_MIN_STRENGTH = 0.5;
/** Cuánto pesa la reacción (volumen, acción, movimiento, chat…) frente a lo que dijo la IA. */
const REACTION_WEIGHT = 0.2;
/** Momentos solo por señales (sin la IA) que se suman a los de la IA, y su score relativo mínimo. */
const MAX_SIGNAL_EXTRAS = 3;
const SIGNAL_EXTRA_MIN_SCORE = 0.9;
/** Un momento solo por señales tiene que ser casi sin habla (lo hablado ya lo juzgó la IA). */
const SIGNAL_EXTRA_MAX_SPEECH = 0.4;

export interface SelectAiMomentsInput {
  highlights: ContentHighlight[];
  durationSeconds: number;
  /** Señales por segundo (como en selectMoments); "speech" se ignora: la IA ya está en los momentos. */
  signals: SignalSeries;
  weights: ScoreWeights;
  /** Duración elegida por el usuario: cada clip dura eso ±5 s (ver clipDurationRange). */
  clipDurationSeconds: number;
  maxClips: number;
  minGapSeconds?: number;
  /** Frases de la transcripción: para cortar en frases completas y saber qué tramos no tienen habla. */
  segments?: TranscriptSegment[];
}

/**
 * La IA decide (videos con voz: podcasts, entrevistas, streams hablados): cada clip es un momento que
 * eligió la IA, llevado al largo obligatorio (duración elegida ±5 s) cortando en frases completas. Si
 * un momento no se puede llevar a ese largo en frases, se descarta y ocupa su lugar el siguiente. Las demás señales solo suben un poco los que además
 * tienen reacción. Si sobra lugar, se agregan hasta 3 momentos muy fuertes solo por señales en
 * tramos casi sin habla (p. ej. una jugada con gritos), siempre por debajo de los de la IA.
 */
export function selectAiMoments(input: SelectAiMomentsInput): Moment[] {
  const total = Math.floor(input.durationSeconds);
  if (total <= 0) return [];
  const gap = input.minGapSeconds ?? 2;
  const { min, max } = clipDurationRange(input.clipDurationSeconds);
  const hasSpeech = (input.segments ?? []).some((s) => s.text.trim() !== "");

  // Reacción por segundo: promedio ponderado de las señales normalizadas (sin la de la IA).
  const reactionNames = (Object.keys(input.signals) as SignalName[]).filter(
    (n) => n !== "speech" && (input.signals[n]?.length ?? 0) > 0 && input.weights[n] > 0,
  );
  const normalized = new Map(reactionNames.map((n) => [n, normalizeSeries(input.signals[n]!, SIGNAL_MIN_RANGE[n])]));
  const reactionWeight = reactionNames.reduce((s, n) => s + input.weights[n], 0);
  const meanOf = (name: SignalName, start: number, end: number) => {
    const values = normalized.get(name)!;
    const from = Math.max(0, Math.floor(start));
    const to = Math.min(values.length, Math.max(from + 1, Math.ceil(end)));
    let sum = 0;
    for (let i = from; i < to; i++) sum += values[i] ?? 0;
    return to > from ? sum / (to - from) : 0;
  };

  const candidates: Moment[] = input.highlights
    .filter((h) => h.strength >= AI_MIN_STRENGTH && h.endSeconds > h.startSeconds)
    .flatMap((h) => {
      // Largo obligatorio: con transcripción, cortando en frases (o se descarta); sin ella, a la medida.
      const bounds = { min, max, videoDurationSeconds: input.durationSeconds };
      const fitted = hasSpeech
        ? fitToSentences(h.startSeconds, h.endSeconds, input.segments!, bounds)
        : clampToRange(h.startSeconds, h.endSeconds, bounds);
      if (!fitted) return [];
      const start = fitted.startSeconds;
      const end = fitted.endSeconds;
      const breakdown: Partial<Record<SignalName, number>> = { speech: round(h.strength) };
      let reaction = 0;
      for (const name of reactionNames) {
        const mean = meanOf(name, start, end);
        breakdown[name] = round(mean);
        reaction += (input.weights[name] / reactionWeight) * mean;
      }
      const score = reactionNames.length ? (1 - REACTION_WEIGHT) * h.strength + REACTION_WEIGHT * reaction : h.strength;
      return [
        {
          startSeconds: round(start),
          endSeconds: round(end),
          score: round(score),
          breakdown,
          ...(h.title ? { title: h.title } : {}),
          ...(h.reason ? { reason: h.reason } : {}),
        },
      ];
    });

  const overlaps = (a: Moment, list: Moment[]) => list.some((c) => a.startSeconds < c.endSeconds + gap && c.startSeconds < a.endSeconds + gap);
  const chosen: Moment[] = [];
  for (const m of candidates.sort((a, b) => b.score - a.score || a.startSeconds - b.startSeconds)) {
    if (chosen.length >= input.maxClips) break;
    if (!overlaps(m, chosen)) chosen.push(m);
  }

  // Momentos muy fuertes solo por señales (sin habla): pocos y por debajo de los de la IA.
  if (chosen.length < input.maxClips && reactionNames.length) {
    const floor = chosen.length ? Math.min(...chosen.map((c) => c.score)) : 1;
    const signalOnly = Object.fromEntries(reactionNames.map((n) => [n, input.signals[n]!])) as SignalSeries;
    const extras = selectMoments({
      durationSeconds: input.durationSeconds,
      signals: signalOnly,
      weights: input.weights,
      clipDurationSeconds: input.clipDurationSeconds,
      minScore: SIGNAL_EXTRA_MIN_SCORE,
      maxClips: input.maxClips,
      minGapSeconds: gap,
    });
    const speechShare = (m: Moment) => {
      let spoken = 0;
      for (const seg of input.segments ?? []) {
        if (!seg.text.trim()) continue;
        spoken += Math.max(0, Math.min(seg.endSeconds, m.endSeconds) - Math.max(seg.startSeconds, m.startSeconds));
      }
      return spoken / Math.max(1, m.endSeconds - m.startSeconds);
    };
    let added = 0;
    for (const m of extras) {
      if (chosen.length >= input.maxClips || added >= MAX_SIGNAL_EXTRAS) break;
      if (overlaps(m, chosen) || speechShare(m) > SIGNAL_EXTRA_MAX_SPEECH) continue;
      chosen.push({ ...m, score: round(Math.min(m.score, floor) * 0.99) });
      added++;
    }
  }
  return chosen.sort((a, b) => a.startSeconds - b.startSeconds);
}

const round = (n: number) => Math.round(n * 10_000) / 10_000;
