import { describe, expect, it } from "vitest";
import { DEFAULT_PRODUCT_CONFIG } from "../product-config.js";
import { aiClipBounds, selectAiMoments } from "./ai-moments.js";

const weights = DEFAULT_PRODUCT_CONFIG.scoreWeights;
const flat = (n: number, v = -30) => Array.from({ length: n }, () => v);

describe("selectAiMoments (la IA decide)", () => {
  it("usa el inicio y el final que eligió la IA, aunque la duración elegida sea otra", () => {
    const moments = selectAiMoments({
      durationSeconds: 600,
      highlights: [
        { startSeconds: 100, endSeconds: 152, strength: 0.9 }, // una historia de 52 s con clips "de 30 s"
        { startSeconds: 300, endSeconds: 318, strength: 0.7 },
      ],
      signals: { audio: flat(600) },
      weights,
      clipDurationSeconds: 30,
      maxClips: 15,
    });
    expect(moments.map((m) => [m.startSeconds, m.endSeconds])).toEqual([
      [100, 152],
      [300, 318],
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

  it("alarga los muy cortos y recorta los muy largos según la duración elegida", () => {
    expect(aiClipBounds(30)).toEqual({ min: 15, max: 60 });
    expect(aiClipBounds(90)).toEqual({ min: 45, max: 90 });
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
    expect(moments.map((m) => m.endSeconds - m.startSeconds)).toEqual([15, 60]);
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
      segments: [{ startSeconds: 95, endSeconds: 135, text: "dato interesante" }],
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
      segments: [{ startSeconds: 0, endSeconds: 600, text: "hablan todo el tiempo" }],
    });
    expect(moments.map((m) => m.startSeconds)).toEqual([100]);
  });
});
