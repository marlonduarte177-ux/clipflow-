import { describe, expect, it } from "vitest";
import { DEFAULT_PRODUCT_CONFIG, loadProductConfig } from "./product-config.js";

describe("loadProductConfig", () => {
  it("usa los valores por defecto si no hay variables", () => {
    expect(loadProductConfig({})).toEqual(DEFAULT_PRODUCT_CONFIG);
  });

  it("permite cambiar las duraciones de clip por entorno (ordenadas y sin duplicados)", () => {
    const config = loadProductConfig({ CLIP_DURATIONS_SECONDS: "60, 20,20,120" });
    expect(config.clipDurationsSeconds).toEqual([20, 60, 120]);
  });

  it("permite cambiar los pesos del score", () => {
    const config = loadProductConfig({ SCORE_WEIGHT_AUDIO: "0.9", SCORE_WEIGHT_OCR: "0" });
    expect(config.scoreWeights.audio).toBe(0.9);
    expect(config.scoreWeights.ocr).toBe(0);
    expect(config.scoreWeights.speech).toBe(DEFAULT_PRODUCT_CONFIG.scoreWeights.speech);
  });

  it("ignora variables vacías", () => {
    expect(loadProductConfig({ CLIP_DURATIONS_SECONDS: "  " }).clipDurationsSeconds).toEqual(
      DEFAULT_PRODUCT_CONFIG.clipDurationsSeconds,
    );
  });

  it("rechaza valores inválidos con un mensaje claro", () => {
    expect(() => loadProductConfig({ CLIP_DURATIONS_SECONDS: "30,abc" })).toThrow(
      /CLIP_DURATIONS_SECONDS/,
    );
    expect(() => loadProductConfig({ MIN_CLIP_SCORE: "1.5" })).toThrow(/entre 0 y 1/);
    expect(() => loadProductConfig({ SCORE_WEIGHT_AUDIO: "-1" })).toThrow(/SCORE_WEIGHT_AUDIO/);
  });

  it("rechaza que todos los pesos sean 0", () => {
    expect(() =>
      loadProductConfig({
        SCORE_WEIGHT_AUDIO: "0",
        SCORE_WEIGHT_SPEECH: "0",
        SCORE_WEIGHT_VISUAL: "0",
        SCORE_WEIGHT_OCR: "0",
        SCORE_WEIGHT_REACTION: "0",
      }),
    ).toThrow(/mayor que 0/);
  });
});
