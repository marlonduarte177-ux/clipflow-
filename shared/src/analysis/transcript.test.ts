import { describe, expect, it } from "vitest";
import { clampToRange, clipDurationRange, fitToSentences, segmentsForRange, snapToSentences, speechSignalFromHighlights, toSrt, toVtt } from "./transcript.js";

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

describe("duración obligatoria de los clips", () => {
  /** Frases de 5 s seguidas: [from, from+5], [from+5, from+10]… */
  const sentences = (from: number, to: number, step = 5) =>
    Array.from({ length: Math.floor((to - from) / step) }, (_, i) => ({ startSeconds: from + i * step, endSeconds: from + (i + 1) * step, text: `Frase ${i}.` }));
  const bounds60 = { ...clipDurationRange(60), videoDurationSeconds: 3600 };

  it("rango: lo pedido ±5 s", () => {
    expect(clipDurationRange(60)).toEqual({ min: 55, max: 65 });
    expect(clipDurationRange(30)).toEqual({ min: 25, max: 35 });
    expect(clipDurationRange(15)).toEqual({ min: 10, max: 20 });
  });

  it("un momento corto se alarga con las frases que siguen hasta el largo pedido", () => {
    expect(fitToSentences(100, 122, sentences(0, 600), bounds60)).toEqual({ startSeconds: 100, endSeconds: 160 });
  });

  it("uno largo se recorta en un final de frase; uno que ya está en rango se respeta", () => {
    expect(fitToSentences(100, 190, sentences(0, 600), bounds60)).toEqual({ startSeconds: 100, endSeconds: 160 });
    expect(fitToSentences(100, 163, sentences(0, 600), bounds60)).toEqual({ startSeconds: 100, endSeconds: 165 });
  });

  it("empieza en la frase donde arranca la idea (aunque la IA marque a mitad de frase)", () => {
    expect(fitToSentences(102, 160, sentences(0, 600), bounds60)).toEqual({ startSeconds: 100, endSeconds: 160 });
  });

  it("si no hay ningún corte en frases con ese largo, devuelve null (el momento se descarta)", () => {
    const long = [{ startSeconds: 0, endSeconds: 100, text: "Una frase larguísima." }, { startSeconds: 100, endSeconds: 200, text: "Otra." }];
    expect(fitToSentences(10, 70, long, bounds60)).toBeNull();
    // Momento en un tramo sin habla.
    expect(fitToSentences(1000, 1060, sentences(0, 600), bounds60)).toBeNull();
  });

  it("al final del video, puede empezar una frase antes para llegar al largo", () => {
    const fitted = fitToSentences(560, 600, sentences(0, 600), { ...bounds60, videoDurationSeconds: 600 })!;
    expect(fitted.endSeconds - fitted.startSeconds).toBeGreaterThanOrEqual(55);
    expect(fitted.endSeconds).toBeLessThanOrEqual(600);
  });

  it("sin frases: a la medida, sin salirse del video", () => {
    expect(clampToRange(100, 110, bounds60)).toEqual({ startSeconds: 100, endSeconds: 155 });
    expect(clampToRange(580, 700, { ...bounds60, videoDurationSeconds: 600 })).toEqual({ startSeconds: 535, endSeconds: 600 });
    expect(clampToRange(0, 20, { ...bounds60, videoDurationSeconds: 40 })).toEqual({ startSeconds: 0, endSeconds: 40 });
  });
});
