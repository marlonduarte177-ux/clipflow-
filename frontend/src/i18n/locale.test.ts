import { describe, expect, it } from "vitest";
import { MESSAGES } from "./messages";
import { resolveLocale } from "./locale";

describe("idioma de la app", () => {
  it("usa la cookie si es válida; si no, el idioma del navegador; si no, español", () => {
    expect(resolveLocale("en", "es-CR")).toBe("en");
    expect(resolveLocale("es", "en-US")).toBe("es");
    expect(resolveLocale(undefined, "en-US,en;q=0.9")).toBe("en");
    expect(resolveLocale("fr", "pt-BR")).toBe("es");
    expect(resolveLocale(null, null)).toBe("es");
  });

  it("el inglés tiene todos los textos del español (y ninguno vacío)", () => {
    const keys = (o: object, prefix = ""): string[] =>
      Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" && !Array.isArray(v) ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
    expect(keys(MESSAGES.en).sort()).toEqual(keys(MESSAGES.es).sort());
    const empty = keys(MESSAGES.en).filter((k) => {
      const v = k.split(".").reduce<unknown>((o, part) => (o as Record<string, unknown>)[part], MESSAGES.en);
      return typeof v === "string" && !v.trim();
    });
    expect(empty).toEqual([]);
  });
});
