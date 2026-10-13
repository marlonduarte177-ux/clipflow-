import type { ScoreWeights } from "../product-config.js";
import type { ContentHighlight, SoundEvent, TranscriptSegment } from "./ai-provider.js";
import { clampToRange, clipDurationRange, fitToSentences } from "./transcript.js";
import { normalizeSeries, selectMoments, SIGNAL_MIN_RANGE, type Moment, type SignalName, type SignalSeries } from "./scoring.js";
import { soundBonus } from "./sounds.js";

/** Fuerza mínima (0–1) que la IA le dio a un momento para que sea clip (los mejores van primero). */
export const AI_MIN_STRENGTH = 0.3;
/**
 * Clips que se intentan entregar como mínimo (si caben en el video sin pisarse): si la IA propone
 * menos, se completan con los tramos de más reacción (volumen, acción, movimiento, risas…).
 */
export const MIN_CLIPS_PER_VIDEO = 10;
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
  /** Mínimo de clips a entregar si caben (ver MIN_CLIPS_PER_VIDEO). */
  minClips?: number;
  minGapSeconds?: number;
  /** Frases de la transcripción: para cortar en frases completas y saber qué tramos no tienen habla. */
  segments?: TranscriptSegment[];
  /** Sonidos detectados (versión nueva): los momentos con risas o gritos suben de puntaje. */
  sounds?: SoundEvent[];
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
      const base = reactionNames.length ? (1 - REACTION_WEIGHT) * h.strength + REACTION_WEIGHT * reaction : h.strength;
      const bonus = input.sounds?.length ? soundBonus(input.sounds, start, end) : 0;
      const score = Math.min(1, base + bonus);
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

  // Menos clips que el mínimo: se completan con los tramos de más reacción que no se pisen (cortados
  // en frases completas si hay habla), siempre con puntaje por debajo de los de la IA.
  const minClips = Math.min(input.minClips ?? 0, input.maxClips);
  if (chosen.length < minClips) {
    const floor = chosen.length ? Math.min(...chosen.map((c) => c.score)) : 1;
    const bounds = { min, max, videoDurationSeconds: input.durationSeconds };
    // Varias pasadas: los huecos que deja una pasada se buscan de nuevo en la siguiente.
    for (let pass = 0; pass < 3 && chosen.length < minClips; pass++) {
      for (const m of fillMoments(input, chosen, gap)) {
        if (chosen.length >= minClips) break;
        const fitted = hasSpeech ? (fitToSentences(m.startSeconds, m.endSeconds, input.segments!, bounds) ?? null) : null;
        const candidate = fitted ? { ...m, startSeconds: round(fitted.startSeconds), endSeconds: round(fitted.endSeconds) } : m;
        if (overlaps(candidate, chosen)) continue;
        chosen.push({ ...candidate, score: round(Math.min(m.score, floor) * 0.98) });
      }
    }
  }
  return chosen.sort((a, b) => a.startSeconds - b.startSeconds);
}

/**
 * Tramos del largo pedido ordenados por reacción (sin puntaje mínimo), para completar el mínimo de
 * clips. Si ninguna señal varía (video plano), tramos repartidos a lo largo del video.
 */
export function fillMoments(
  input: Pick<SelectAiMomentsInput, "durationSeconds" | "signals" | "weights" | "clipDurationSeconds" | "maxClips">,
  taken: Moment[],
  gap: number,
): Moment[] {
  const names = (Object.keys(input.signals) as SignalName[]).filter((n) => (input.signals[n]?.length ?? 0) > 0 && input.weights[n] > 0);
  const signals = Object.fromEntries(names.map((n) => [n, input.signals[n]!])) as SignalSeries;
  const ranked = names.length
    ? selectMoments({
        durationSeconds: input.durationSeconds,
        signals,
        weights: input.weights,
        clipDurationSeconds: input.clipDurationSeconds,
        minScore: 0,
        maxClips: input.maxClips + taken.length,
        minGapSeconds: gap,
      }).sort((a, b) => b.score - a.score)
    : [];
  // Último recurso (video plano, o huecos que quedaron entre los elegidos): tramos seguidos, cada
  // uno pegado al anterior ya ocupado.
  const clip = Math.max(1, Math.round(input.clipDurationSeconds));
  const busy = [...taken].sort((a, b) => a.startSeconds - b.startSeconds);
  const even: Moment[] = [];
  let start = 0;
  while (start + clip <= input.durationSeconds) {
    const clash = busy.find((m) => start < m.endSeconds + gap && m.startSeconds < start + clip + gap);
    if (clash) {
      start = Math.ceil(clash.endSeconds + gap);
      continue;
    }
    even.push({ startSeconds: start, endSeconds: start + clip, score: 0, breakdown: {} });
    start += clip + gap;
  }
  return [...ranked, ...even];
}

const round = (n: number) => Math.round(n * 10_000) / 10_000;
