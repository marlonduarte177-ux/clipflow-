import { describe, expect, it } from "vitest";
import { DEFAULT_PRODUCT_CONFIG } from "../product-config.js";
import { selectAiMoments } from "./ai-moments.js";

const weights = DEFAULT_PRODUCT_CONFIG.scoreWeights;
const flat = (n: number, v = -30) => Array.from({ length: n }, () => v);
/** Frases de 5 s seguidas entre `from` y `to`. */
const sentences = (from: number, to: number) =>
  Array.from({ length: Math.floor((to - from) / 5) }, (_, i) => ({ startSeconds: from + i * 5, endSeconds: from + i * 5 + 5, text: `Frase ${i}.` }));

describe("selectAiMoments (la IA decide)", () => {
  it("lleva cada momento de la IA a la duración elegida ±5 s, cortando en frases completas", () => {
    const moments = selectAiMoments({
      durationSeconds: 600,
      highlights: [
        { startSeconds: 100, endSeconds: 152, strength: 0.9 }, // 52 s con clips de 30 s: se recorta en una frase
        { startSeconds: 300, endSeconds: 318, strength: 0.7 }, // 18 s: se alarga con las frases que siguen
      ],
      signals: { audio: flat(600) },
      weights,
      clipDurationSeconds: 30,
      maxClips: 15,
      segments: sentences(0, 600),
    });
    expect(moments.map((m) => [m.startSeconds, m.endSeconds])).toEqual([
      [100, 130],
      [300, 330],
    ]);
    expect(moments[0]!.breakdown.speech).toBe(0.9);
  });

  it("descarta los momentos flojos y respeta el máximo de clips (los más fuertes primero)", () => {
    const highlights = Array.from({ length: 10 }, (_, i) => ({ startSeconds: i * 60, endSeconds: i * 60 + 30, strength: 0.4 + i * 0.06 }));
    const moments = selectAiMoments({ durationSeconds: 700, highlights, signals: {}, weights, clipDurationSeconds: 30, maxClips: 3 });
    expect(moments).toHaveLength(3);
    expect(moments.every((m) => m.score >= 0.5)).toBe(true);
    expect(moments.map((m) => m.startSeconds)).toEqual([420, 480, 540]);
  });

  it("sin transcripción, alarga los muy cortos y recorta los muy largos a la medida", () => {
    const moments = selectAiMoments({
      durationSeconds: 600,
      highlights: [
        { startSeconds: 10, endSeconds: 14, strength: 0.8 },
        { startSeconds: 200, endSeconds: 320, strength: 0.8 },
      ],
      signals: {},
      weights,
      clipDurationSeconds: 30,
      maxClips: 15,
    });
    expect(moments.map((m) => m.endSeconds - m.startSeconds)).toEqual([25, 35]);
  });

  it("si un momento no se puede cortar en frases con ese largo, se descarta y entra el siguiente", () => {
    const moments = selectAiMoments({
      durationSeconds: 600,
      highlights: [
        { startSeconds: 400, endSeconds: 430, strength: 0.95 }, // sin habla cerca: no hay dónde cortar
        { startSeconds: 50, endSeconds: 80, strength: 0.8 },
      ],
      signals: {},
      weights,
      clipDurationSeconds: 30,
      maxClips: 1,
      segments: sentences(0, 100),
    });
    expect(moments.map((m) => [m.startSeconds, m.endSeconds])).toEqual([[50, 80]]);
  });

  it("la reacción (volumen, chat…) desempata y sube un poco, pero no manda", () => {
    const audio = flat(600);
    for (let i = 300; i < 330; i++) audio[i] = -5; // gritos en el segundo momento
    const moments = selectAiMoments({
      durationSeconds: 600,
      highlights: [
        { startSeconds: 100, endSeconds: 130, strength: 0.8 },
        { startSeconds: 300, endSeconds: 330, strength: 0.8 },
      ],
      signals: { audio },
      weights,
      clipDurationSeconds: 30,
      maxClips: 1,
    });
    expect(moments.map((m) => m.startSeconds)).toEqual([300]);
  });

  it("suma un momento muy fuerte solo por señales donde casi no se habla (p. ej. una jugada), por debajo de la IA", () => {
    const action = flat(600, 0);
    for (let i = 450; i < 480; i++) action[i] = 8;
    const moments = selectAiMoments({
      durationSeconds: 600,
      highlights: [{ startSeconds: 100, endSeconds: 130, strength: 0.9 }],
      signals: { action },
      weights,
      clipDurationSeconds: 30,
      maxClips: 15,
      segments: sentences(95, 135),
    });
    expect(moments).toHaveLength(2);
    const extra = moments.find((m) => m.startSeconds >= 440)!;
    expect(extra.score).toBeLessThan(moments.find((m) => m.startSeconds === 100)!.score);
  });

  it("en un podcast (todo hablado) no agrega momentos solo por volumen", () => {
    const audio = flat(600);
    for (let i = 450; i < 480; i++) audio[i] = -5;
    const moments = selectAiMoments({
      durationSeconds: 600,
      highlights: [{ startSeconds: 100, endSeconds: 130, strength: 0.9 }],
      signals: { audio },
      weights,
      clipDurationSeconds: 30,
      maxClips: 15,
      segments: sentences(0, 600),
    });
    expect(moments.map((m) => m.startSeconds)).toEqual([100]);
  });
});
