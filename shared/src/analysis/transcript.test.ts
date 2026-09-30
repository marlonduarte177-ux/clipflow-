import { describe, expect, it } from "vitest";
import { segmentsForRange, snapToSentences, speechSignalFromHighlights, toSrt, toVtt } from "./transcript.js";

const segments = [
  { startSeconds: 0, endSeconds: 4.2, text: "Hola a todos." },
  { startSeconds: 4.2, endSeconds: 9.8, text: "Hoy les cuento algo increíble." },
  { startSeconds: 9.8, endSeconds: 31.5, text: "Resulta que..." },
  { startSeconds: 31.5, endSeconds: 40, text: "Y así terminó." },
];

describe("speechSignalFromHighlights", () => {
  it("marca cada segundo con la fuerza del mejor momento que lo cubre", () => {
    const signal = speechSignalFromHighlights(
      [
        { startSeconds: 2, endSeconds: 5, strength: 0.5 },
        { startSeconds: 4, endSeconds: 6, strength: 0.9 },
      ],
      8,
    );
    expect(signal).toEqual([0, 0, 0.5, 0.5, 0.9, 0.9, 0, 0]);
  });
});

describe("snapToSentences", () => {
  const moment = { startSeconds: 5, endSeconds: 30, score: 1, breakdown: {} };
  it("mueve los bordes al inicio y fin de frase más cercanos", () => {
    expect(snapToSentences(moment, segments, { videoDurationSeconds: 40 })).toMatchObject({
      startSeconds: 4.2,
      endSeconds: 31.5,
    });
  });

  it("no mueve un borde más de lo permitido", () => {
    const far = [{ startSeconds: 0, endSeconds: 100, text: "una frase larguísima" }];
    expect(snapToSentences(moment, far, { videoDurationSeconds: 100 })).toMatchObject({ startSeconds: 5, endSeconds: 30 });
  });

  it("sin transcripción no cambia nada", () => {
    expect(snapToSentences(moment, [], { videoDurationSeconds: 40 })).toBe(moment);
  });
});

describe("subtítulos", () => {
  const clip = segmentsForRange(segments, 4.2, 31.5);

  it("toma las frases del clip con tiempos relativos al clip", () => {
    expect(clip).toEqual([
      { startSeconds: 0, endSeconds: 5.6, text: "Hoy les cuento algo increíble." },
      { startSeconds: 5.6, endSeconds: 27.3, text: "Resulta que..." },
    ]);
  });

  it("genera SRT y VTT válidos", () => {
    expect(toSrt(clip)).toBe(
      "1\n00:00:00,000 --> 00:00:05,600\nHoy les cuento algo increíble.\n\n2\n00:00:05,600 --> 00:00:27,300\nResulta que...\n",
    );
    expect(toVtt(clip).startsWith("WEBVTT\n\n00:00:00.000 --> 00:00:05.600\n")).toBe(true);
  });
});
