import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { translateMessage } from "./i18n.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Textos en español que el servidor muestra al usuario, sacados del código fuente. */
function userMessages(dir: string, patterns: RegExp[]): string[] {
  const files = readdirSync(path.join(ROOT, dir), { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => readFileSync(path.join(ROOT, dir, f), "utf8"));
  const found = new Set<string>();
  for (const src of files) for (const re of patterns) for (const m of src.matchAll(re)) found.add(m[1]!);
  return [...found];
}

describe("translateMessage", () => {
  it("en español devuelve el mensaje igual; vacío sigue vacío", () => {
    expect(translateMessage("Video no encontrado.", "es")).toBe("Video no encontrado.");
    expect(translateMessage(null, "en")).toBeNull();
  });

  it("traduce mensajes con datos y mensajes dentro de otros", () => {
    expect(translateMessage("Ocurrió un error temporal al guardar el video importado (AccessDenied). Lo intentaremos de nuevo.", "en")).toBe(
      "A temporary error occurred while trying to save the imported video (AccessDenied). We'll try again.",
    );
    expect(translateMessage("No pudimos abrir el video original para cortar los clips: No encontramos un video en ese enlace.", "en")).toBe(
      "We couldn't open the original video to cut the clips: We couldn't find a video at that link.",
    );
    expect(translateMessage("falló la transcripción: La clave de OpenAI no es válida", "en")).toBe("transcription failed: The OpenAI key is not valid");
    expect(translateMessage("Nuestro servicio de descarga no respondió (proxy: sin saldo, 402). Lo intentaremos de nuevo.", "en")).toContain(
      "proxy: no balance, 402",
    );
    expect(translateMessage("falló la transcripción: AssemblyAI tuvo un error temporal (503)", "en")).toBe(
      "transcription failed: AssemblyAI had a temporary error (503)",
    );
  });

  it("cada mensaje fijo de la API, la validación y el procesador tiene traducción al inglés", () => {
    const messages = [
      ...userMessages("backend/src", [/sendError\([^,]+,\s*\d+,\s*"[a-z_]+",\s*"([^"]+)"/g, /message: "([^"]+)"/g]),
      ...userMessages("shared/src", [/message: "([^"]+)"/g, /\.(?:min|max|refine)\([^"]*"([^"]+)"/g]),
      ...userMessages("worker/src", [
        /new DownloadError\(\s*"([^"]+)"/g,
        /new JobError\("[a-z_]+", "([^"]+)"/g,
        /message: "([^"]+)"/g,
        /reason: "([^"]+)"/g,
      ]),
    ].filter((m) => /^[A-ZÁÉÍÓÚ¿¡]/.test(m) && m.includes(" ")); // frases para el usuario (no códigos)
    expect(messages.length).toBeGreaterThan(50);
    const missing = messages.filter((m) => translateMessage(m, "en") === m);
    expect(missing).toEqual([]);
  });
});
