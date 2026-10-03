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

describe("visión", () => {
  const frames = [
    { timeSeconds: 3, score: 0.2, label: "Corriendo" },
    { timeSeconds: 6, score: 0.9, label: "Eliminación doble" },
    { timeSeconds: 9, score: 0.4, label: "Recargando" },
  ];

  it("convierte fotogramas puntuados en una señal por segundo", async () => {
    const { visionSignalFromFrames } = await import("./transcript.js");
    expect(visionSignalFromFrames(frames, 12, 3)).toEqual([0, 0, 0.2, 0.2, 0.2, 0.9, 0.9, 0.9, 0.4, 0.4, 0.4, 0]);
  });

  it("usa la etiqueta del mejor fotograma del tramo como título, si es un buen momento", async () => {
    const { bestFrameLabel } = await import("./transcript.js");
    expect(bestFrameLabel(frames, 0, 10)).toBe("Eliminación doble");
    expect(bestFrameLabel(frames, 8, 10)).toBeNull(); // 0.4: no merece título
  });
});

describe("snapToSentences hacia afuera (momentos de la IA)", () => {
  it("empieza en la frase de antes y termina en la de después, sin recortar la idea", () => {
    const segments = [0, 5, 10, 15].map((s) => ({ startSeconds: s, endSeconds: s + 5, text: "x" }));
    const moment = { startSeconds: 2, endSeconds: 12, score: 1, breakdown: {} };
    expect(snapToSentences(moment, segments, { videoDurationSeconds: 20 })).toMatchObject({ startSeconds: 0, endSeconds: 10 });
    expect(snapToSentences(moment, segments, { videoDurationSeconds: 20, outward: true })).toMatchObject({ startSeconds: 0, endSeconds: 15 });
  });
});
