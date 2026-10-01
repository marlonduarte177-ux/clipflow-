import { describe, expect, it } from "vitest";
import { languageName } from "./language";
import { clock, parseVtt } from "./vtt";

describe("transcripción (WebVTT)", () => {
  it("lee las frases con sus tiempos, igual que las escribe el worker", () => {
    const vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:04.500\nHola a todos\n\n00:00:04.500 --> 00:01:02.250\nSegunda frase\ncon dos líneas\n";
    expect(parseVtt(vtt)).toEqual([
      { start: 0, end: 4.5, text: "Hola a todos" },
      { start: 4.5, end: 62.25, text: "Segunda frase con dos líneas" },
    ]);
  });

  it("ignora bloques sin tiempos o vacíos y acepta saltos de línea de Windows", () => {
    expect(parseVtt("WEBVTT\r\n\r\nNOTE algo\r\n\r\n00:00:01.000 --> 00:00:02.000\r\n\r\n")).toEqual([]);
  });

  it("muestra los tiempos como en un reproductor", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(75.9)).toBe("1:15");
    expect(clock(3725)).toBe("1:02:05");
  });

  it("muestra el idioma en español", () => {
    expect(languageName("spanish")).toBe("Español");
    expect(languageName("English")).toBe("Inglés");
    expect(languageName("swahili")).toBe("Swahili");
    expect(languageName(null)).toBeNull();
  });
});
