import type { ScoreWeights } from "../product-config.js";

/** Nombre de cada señal de interés; coincide con los pesos de la configuración. */
export type SignalName = keyof ScoreWeights;

/**
 * Señales por segundo del video: `values[i]` describe el segundo i.
 * Solo se incluyen las señales disponibles (p. ej. sin IA no hay "speech").
 */
export type SignalSeries = Partial<Record<SignalName, number[]>>;

export interface Moment {
  startSeconds: number;
  endSeconds: number;
  /**
   * Score 0–1 RELATIVO a este video: 1 = el momento con más señal del video,
   * 0 = el de menos. Así el umbral significa lo mismo en videos tranquilos o intensos.
   */
  score: number;
  /** Aporte de cada señal (0–1) en esta ventana. */
  breakdown: Partial<Record<SignalName, number>>;
  /** Título y motivo que dio la IA para este momento (si lo eligió ella). */
  title?: string;
  reason?: string;
}

export interface SelectMomentsInput {
  durationSeconds: number;
  signals: SignalSeries;
  weights: ScoreWeights;
  clipDurationSeconds: number;
  minScore: number;
  maxClips: number;
  /** Separación mínima entre clips, en segundos. */
  minGapSeconds?: number;
}

/**
 * Variación mínima para que una señal cuente como "algo pasó". Evita que el ruido
 * (p. ej. ±0.01 dB de la compresión de audio) se amplifique hasta parecer un momento.
 * Unidades: audio en dB; visual en movimiento/cambio de escena de FFmpeg; action en picos por segundo.
 */
export const SIGNAL_MIN_RANGE: Record<SignalName, number> = {
  audio: 3,
  visual: 0.1,
  speech: 0,
  ocr: 0,
  reaction: 0,
  action: 1, // al menos un pico de diferencia entre segundos
  vision: 0,
  chat: 0,
};

/** Normaliza a 0–1 usando percentiles 5 y 95 (resistente a valores extremos). */
export function normalizeSeries(values: number[], minRange = 0): number[] {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return values.map(() => 0);
  const pick = (p: number) => finite[Math.min(finite.length - 1, Math.floor(p * (finite.length - 1)))]!;
  const low = pick(0.05);
  const high = pick(0.95);
  if (high - low < Math.max(1e-9, minRange)) {
    // Sin variación real. Si hay picos aislados por encima del rango (p. ej. dos cambios de
    // escena en todo el video), se marcan; si no, la señal no aporta nada.
    return values.map((v) => (Number.isFinite(v) && v - low >= minRange && minRange > 0 ? 1 : 0));
  }
  return values.map((v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, (v - low) / (high - low))) : 0));
}

/**
 * Elige los mejores momentos: calcula el score de cada ventana de `clipDurationSeconds`
 * (promedio ponderado de las señales disponibles, llevado a escala 0–1 dentro del video)
 * y toma las mejores sin solaparse.
 * Solo devuelve ventanas con score >= minScore: si el video tiene 3 momentos buenos, devuelve 3.
 */
export function selectMoments(input: SelectMomentsInput): Moment[] {
  const total = Math.floor(input.durationSeconds);
  if (total <= 0) return [];
  const clip = Math.min(input.clipDurationSeconds, total);
  const gap = input.minGapSeconds ?? 2;

  const available = (Object.keys(input.signals) as SignalName[]).filter(
    (name) => (input.signals[name]?.length ?? 0) > 0 && input.weights[name] > 0,
  );
  if (available.length === 0) return [];
  const weightSum = available.reduce((sum, name) => sum + input.weights[name], 0);

  // Sumas acumuladas para calcular el promedio de cualquier ventana en O(1).
  const prefix = new Map<SignalName, Float64Array>();
  for (const name of available) {
    const normalized = normalizeSeries(input.signals[name]!, SIGNAL_MIN_RANGE[name]);
    const acc = new Float64Array(total + 1);
    for (let i = 0; i < total; i++) acc[i + 1] = acc[i]! + (normalized[i] ?? 0);
    prefix.set(name, acc);
  }

  const windows: Moment[] = [];
  for (let start = 0; start + clip <= total; start++) {
    const breakdown: Partial<Record<SignalName, number>> = {};
    let score = 0;
    for (const name of available) {
      const acc = prefix.get(name)!;
      const mean = (acc[start + clip]! - acc[start]!) / clip;
      breakdown[name] = round(mean);
      score += (input.weights[name] / weightSum) * mean;
    }
    windows.push({ startSeconds: start, endSeconds: start + clip, score: round(score), breakdown });
  }

  // Escala relativa: sin variación (video plano) no hay momentos destacados.
  // Excepción: un video más corto que el clip es una sola ventana (el video completo).
  const rawScores = windows.map((w) => w.score);
  const min = Math.min(...rawScores);
  const max = Math.max(...rawScores);
  if (windows.length === 1) windows[0]!.score = 1;
  else if (max - min < 1e-6) return [];
  else for (const w of windows) w.score = round((w.score - min) / (max - min));

  windows.sort((a, b) => b.score - a.score || a.startSeconds - b.startSeconds);
  const chosen: Moment[] = [];
  for (const w of windows) {
    if (chosen.length >= input.maxClips || w.score < input.minScore) break;
    const overlaps = chosen.some((c) => w.startSeconds < c.endSeconds + gap && c.startSeconds < w.endSeconds + gap);
    if (!overlaps) chosen.push(w);
  }
  return chosen.sort((a, b) => a.startSeconds - b.startSeconds);
}

const round = (n: number) => Math.round(n * 10_000) / 10_000;
