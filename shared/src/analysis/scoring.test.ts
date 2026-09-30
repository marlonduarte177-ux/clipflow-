import { describe, expect, it } from "vitest";
import { DEFAULT_PRODUCT_CONFIG } from "../product-config.js";
import { normalizeSeries, selectMoments } from "./scoring.js";

const weights = DEFAULT_PRODUCT_CONFIG.scoreWeights;
/** Serie plana con picos en los segundos indicados (por defecto, volumen en dB). */
function series(length: number, peaks: [number, number][], base = -40, peak = -10) {
  const v = Array.from({ length }, () => base);
  for (const [from, to] of peaks) for (let i = from; i < to; i++) v[i] = peak;
  return v;
}

describe("normalizeSeries", () => {
  it("lleva los valores a 0–1 y tolera series planas", () => {
    const n = normalizeSeries([0, 5, 10, 5, 0]);
    expect(Math.min(...n)).toBe(0);
    expect(Math.max(...n)).toBe(1);
    expect(normalizeSeries([3, 3, 3])).toEqual([0, 0, 0]);
  });

  it("ignora variaciones menores al rango mínimo (ruido), pero respeta picos aislados reales", () => {
    expect(normalizeSeries([-20.01, -20, -19.99, -20], 3)).toEqual([0, 0, 0, 0]);
    const sparse = Array.from({ length: 40 }, (_, i) => (i === 10 ? 0.6 : 0));
    expect(normalizeSeries(sparse, 0.1)[10]).toBe(1);
  });
});

describe("selectMoments", () => {
  it("encuentra los momentos con más señal y no fuerza una cantidad fija", () => {
    const moments = selectMoments({
      durationSeconds: 600,
      signals: { audio: series(600, [[100, 130], [400, 430], [500, 530]]) },
      weights,
      clipDurationSeconds: 30,
      minScore: 0.6,
      maxClips: 10,
    });
    expect(moments.map((m) => m.startSeconds)).toEqual([100, 400, 500]); // 3 buenos → 3 clips
    for (const m of moments) {
      expect(m.endSeconds - m.startSeconds).toBe(30);
      expect(m.score).toBeGreaterThanOrEqual(0.6);
      expect(m.breakdown.audio).toBeDefined();
    }
  });

  it("devuelve 0 clips si nada supera el umbral", () => {
    expect(
      selectMoments({ durationSeconds: 300, signals: { audio: series(300, []) }, weights, clipDurationSeconds: 30, minScore: 0.6, maxClips: 10 }),
    ).toEqual([]);
  });

  it("respeta el máximo y no solapa clips", () => {
    const moments = selectMoments({
      durationSeconds: 1000,
      signals: { audio: Array.from({ length: 1000 }, (_, i) => -40 + (30 * (i % 97)) / 97) },
      weights,
      clipDurationSeconds: 45,
      minScore: 0,
      maxClips: 4,
    });
    expect(moments).toHaveLength(4);
    for (let i = 1; i < moments.length; i++) {
      expect(moments[i]!.startSeconds).toBeGreaterThanOrEqual(moments[i - 1]!.endSeconds);
    }
  });

  it("combina señales según sus pesos, ignorando las que faltan", () => {
    const audioPeak = series(300, [[10, 40]]);
    const visualPeak = series(300, [[200, 230]], 0, 1); // puntuación de escena
    const moments = selectMoments({
      durationSeconds: 300,
      signals: { audio: audioPeak, visual: visualPeak },
      weights: { ...weights, audio: 0.9, visual: 0.1 },
      clipDurationSeconds: 30,
      minScore: 0.5,
      maxClips: 5,
    });
    expect(moments.map((m) => m.startSeconds)).toEqual([10]); // solo el pico de audio pesa lo suficiente
  });

  it("un video más corto que el clip genera como máximo un clip del video completo", () => {
    const moments = selectMoments({
      durationSeconds: 12.4,
      signals: { audio: Array.from({ length: 12 }, (_, i) => -40 + i * 3) },
      weights,
      clipDurationSeconds: 30,
      minScore: 0,
      maxClips: 5,
    });
    expect(moments).toEqual([expect.objectContaining({ startSeconds: 0, endSeconds: 12 })]);
  });
});
