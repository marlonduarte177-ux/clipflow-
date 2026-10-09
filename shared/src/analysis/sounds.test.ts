import { describe, expect, it } from "vitest";
import { DEFAULT_PRODUCT_CONFIG } from "../product-config.js";
import { selectAiMoments } from "./ai-moments.js";
import { annotateTranscript, reactionSignalFromSounds, soundBonus } from "./sounds.js";
import type { SoundEvent } from "./ai-provider.js";

const laugh = (start: number, end: number): SoundEvent => ({ kind: "laughter", startSeconds: start, endSeconds: end, confidence: 0.8 });

describe("sonidos en la transcripción y en el puntaje", () => {
  it("marca cada sonido en su lugar de la transcripción", () => {
    const text = annotateTranscript(
      [
        { startSeconds: 0, endSeconds: 4, text: "Te cuento algo" },
        { startSeconds: 4, endSeconds: 9.5, text: "y se cayó" },
      ],
      [laugh(9.6, 12), { kind: "scream", startSeconds: 4, endSeconds: 5, confidence: 0.9 }, { kind: "cheer", startSeconds: 20, endSeconds: 22, confidence: 0.5 }],
    );
    expect(text).toBe(
      "[0.0-4.0] Te cuento algo\n[4.0-9.5] y se cayó\n[4.0-5.0] [grito]\n[9.6-12.0] [risas]\n[20.0-22.0] [vítores]",
    );
  });

  it("da puntos extra a los momentos con risas o gritos (más si hay varios) y algo menos con aplausos", () => {
    expect(soundBonus([], 0, 30)).toBe(0);
    expect(soundBonus([laugh(40, 42)], 0, 30)).toBe(0); // fuera del momento
    expect(soundBonus([laugh(10, 12)], 0, 30)).toBeCloseTo(0.1);
    expect(soundBonus([laugh(10, 12), laugh(20, 22)], 0, 30)).toBeCloseTo(0.15);
    expect(soundBonus([{ kind: "applause", startSeconds: 5, endSeconds: 8, confidence: 0.6 }], 0, 30)).toBeCloseTo(0.05);
    expect(soundBonus([laugh(10, 12), laugh(20, 22), { kind: "cheer", startSeconds: 25, endSeconds: 27, confidence: 0.6 }], 0, 30)).toBeCloseTo(0.15);
  });

  it("la señal de reacción vale la seguridad del sonido en cada segundo", () => {
    expect(reactionSignalFromSounds([laugh(1.5, 3.2)], 5)).toEqual([0, 0.8, 0.8, 0.8, 0]);
  });

  it("entre dos momentos igual de buenos para la IA, gana el que tiene risas", () => {
    const segments = Array.from({ length: 40 }, (_, i) => ({ startSeconds: i * 5, endSeconds: i * 5 + 5, text: `Frase ${i}.` }));
    const highlights = [
      { startSeconds: 20, endSeconds: 50, strength: 0.7 },
      { startSeconds: 100, endSeconds: 130, strength: 0.7 },
    ];
    const base = { durationSeconds: 200, highlights, signals: {}, weights: DEFAULT_PRODUCT_CONFIG.scoreWeights, clipDurationSeconds: 30, maxClips: 5, segments };
    const without = selectAiMoments(base);
    expect(without[0]!.score).toBe(without[1]!.score);
    const withLaugh = selectAiMoments({ ...base, sounds: [laugh(118, 121)] });
    expect(withLaugh.find((m) => m.startSeconds === 100)!.score).toBeCloseTo(0.8);
    expect(withLaugh.find((m) => m.startSeconds === 20)!.score).toBeCloseTo(0.7);
  });
});
