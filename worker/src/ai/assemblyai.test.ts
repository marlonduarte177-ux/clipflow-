import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AssemblyAITranscriber, toSegments } from "./assemblyai.js";

const dir = mkdtempSync(path.join(tmpdir(), "assemblyai-test-"));
const chunkA = path.join(dir, "audio-000.mp3");
const chunkB = path.join(dir, "audio-001.mp3");
writeFileSync(chunkA, Buffer.alloc(1024, 1));
writeFileSync(chunkB, Buffer.alloc(512, 2));

type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown };

/** AssemblyAI de prueba: sube, "procesa" (una vez en cola), devuelve frases y registra cada pedido. */
function fakeAssembly(options: { failStatus?: number; transcriptStatus?: string } = {}) {
  const calls: Call[] = [];
  const polls = new Map<string, number>();
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const headers = { ...((init?.headers as Record<string, string>) ?? {}) };
    const call: Call = { url: u, method: init?.method ?? "GET", headers };
    if (typeof init?.body === "string") call.body = JSON.parse(init.body);
    calls.push(call);
    if (options.failStatus) return new Response("{}", { status: options.failStatus });
    // Cada trozo se reconoce por su tamaño (se suben a la vez: el orden de llegada varía).
    if (u.endsWith("/v2/upload")) {
      return Response.json({ upload_url: `https://cdn.example/${(init?.body as Buffer).length === 1024 ? 1 : 2}` });
    }
    if (u.endsWith("/v2/transcript") && call.method === "POST") {
      const n = (call.body as { audio_url: string }).audio_url.split("/").pop();
      return Response.json({ id: `t${n}`, status: "queued" });
    }
    const sentences = /\/v2\/transcript\/(t\d+)\/sentences$/.exec(u);
    if (sentences) {
      return Response.json({
        sentences:
          sentences[1] === "t1"
            ? [
                {
                  text: "Hola a todos.",
                  start: 1000,
                  end: 2500,
                  words: [
                    { text: "Hola", start: 1000, end: 1400 },
                    { text: "a", start: 1500, end: 1600 },
                    { text: "todos.", start: 1700, end: 2500 },
                  ],
                },
              ]
            : [{ text: "Segunda parte.", start: 0, end: 1200, words: [{ text: "Segunda", start: 0, end: 600 }, { text: "parte.", start: 700, end: 1200 }] }],
      });
    }
    const transcript = /\/v2\/transcript\/(t\d+)$/.exec(u);
    if (transcript && call.method === "GET") {
      const seen = (polls.get(transcript[1]!) ?? 0) + 1;
      polls.set(transcript[1]!, seen);
      const status = seen === 1 ? "processing" : (options.transcriptStatus ?? "completed");
      return Response.json({ id: transcript[1], status, language_code: "es", ...(status === "error" ? { error: "detalle técnico" } : {}) });
    }
    if (transcript && call.method === "DELETE") return Response.json({ id: transcript[1] });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { impl, calls };
}

const transcriber = (impl: typeof fetch) =>
  new AssemblyAITranscriber({
    apiKey: "0123456789abcdef0123456789abcdef",
    speechModels: ["universal-3-5-pro", "universal-2"],
    costPerHourUsd: 0.21,
    fetch: impl,
    sleep: async () => undefined,
    pollMs: 1,
  });

describe("AssemblyAI: transcripción con tiempos por palabra", () => {
  it("sube cada trozo, espera, lee las frases con palabras, pasa los tiempos al video y borra la transcripción", async () => {
    const { impl, calls } = fakeAssembly();
    const result = await transcriber(impl).transcribe([
      { path: chunkA, offsetSeconds: 0, durationSeconds: 600 },
      { path: chunkB, offsetSeconds: 600, durationSeconds: 300 },
    ]);
    expect(result.language).toBe("es");
    expect(result.segments).toEqual([
      {
        startSeconds: 1,
        endSeconds: 2.5,
        text: "Hola a todos.",
        words: [
          { startSeconds: 1, endSeconds: 1.4, text: "Hola" },
          { startSeconds: 1.5, endSeconds: 1.6, text: "a" },
          { startSeconds: 1.7, endSeconds: 2.5, text: "todos." },
        ],
      },
      {
        startSeconds: 600,
        endSeconds: 601.2,
        text: "Segunda parte.",
        words: [
          { startSeconds: 600, endSeconds: 600.6, text: "Segunda" },
          { startSeconds: 600.7, endSeconds: 601.2, text: "parte." },
        ],
      },
    ]);
    // 15 min de audio a 0.21 USD/h.
    expect(result.usage).toMatchObject({ audioSeconds: 900 });
    expect(result.usage.estimatedCostUsd).toBeCloseTo(0.0525, 6);

    const submit = calls.find((c) => c.url.endsWith("/v2/transcript") && c.method === "POST")!;
    expect(submit.headers.Authorization).toBe("0123456789abcdef0123456789abcdef");
    expect(submit.body).toMatchObject({ speech_models: ["universal-3-5-pro", "universal-2"], language_detection: true, punctuate: true });
    // Se borra cada transcripción de AssemblyAI al terminar.
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(2);
  });

  it("si AssemblyAI no puede transcribir, falla con un mensaje propio (sin el detalle técnico) y borra igual", async () => {
    const { impl, calls } = fakeAssembly({ transcriptStatus: "error" });
    const error = await transcriber(impl).transcribe([{ path: chunkA, offsetSeconds: 0, durationSeconds: 60 }]).catch((e) => e);
    expect(error.message).toBe("AssemblyAI no pudo transcribir el audio");
    expect(error.retryable).toBe(false);
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
  });

  it("clave inválida: no se reintenta; error del servidor: se reintenta y queda como temporal", async () => {
    const invalid = fakeAssembly({ failStatus: 401 });
    const e1 = await transcriber(invalid.impl).transcribe([{ path: chunkA, offsetSeconds: 0, durationSeconds: 60 }]).catch((e) => e);
    expect(e1).toMatchObject({ message: "La clave de AssemblyAI no es válida", retryable: false, status: 401 });
    expect(invalid.calls).toHaveLength(1);

    const down = fakeAssembly({ failStatus: 503 });
    const e2 = await transcriber(down.impl).transcribe([{ path: chunkA, offsetSeconds: 0, durationSeconds: 60 }]).catch((e) => e);
    expect(e2).toMatchObject({ message: "AssemblyAI tuvo un error temporal (503)", retryable: true, status: 503 });
    expect(down.calls).toHaveLength(4);
  });

  it("parte las frases muy largas en una coma (pasados 8 s) o a los 15 s", () => {
    const words = Array.from({ length: 20 }, (_, i) => ({ text: i === 9 ? "coma," : `p${i}`, start: i * 1000, end: i * 1000 + 900 }));
    const segments = toSegments([{ text: "larga", start: 0, end: 19_900, words }], { offsetSeconds: 100, durationSeconds: 600 });
    expect(segments.map((s) => [s.startSeconds, s.endSeconds])).toEqual([
      [100, 109.9],
      [110, 119.9],
    ]);
    expect(segments[0]!.text.endsWith("coma,")).toBe(true);
  });
});
