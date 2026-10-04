import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AIAnalysisProvider, TranscriptSegment } from "@clipflow/shared";
import { GeminiAnalyzer, geminiCost, geminiPrices } from "./gemini.js";
import { GeminiPipelineAI } from "./gemini-pipeline.js";

const dir = mkdtempSync(path.join(tmpdir(), "gemini-test-"));
const partA = path.join(dir, "ai-part-000.mp4");
const partB = path.join(dir, "ai-part-001.mp4");
writeFileSync(partA, Buffer.alloc(2048));
writeFileSync(partB, Buffer.alloc(1024));

type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown };

/** Google de prueba: sube archivos, los "procesa", responde clips y registra cada pedido. */
function fakeGoogle(answer: (callIndex: number, body: Record<string, unknown>) => Response) {
  const calls: Call[] = [];
  let files = 0;
  let generates = 0;
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const call: Call = { url: u, method: init?.method ?? "GET", headers };
    if (typeof init?.body === "string") call.body = JSON.parse(init.body);
    calls.push(call);
    if (u.endsWith("/upload/v1beta/files")) {
      return new Response("{}", { headers: { "x-goog-upload-url": `https://upload.example/${++files}` } });
    }
    if (u.startsWith("https://upload.example/")) {
      const n = u.split("/").pop();
      return Response.json({ file: { name: `files/f${n}`, uri: `https://files.example/f${n}`, state: "PROCESSING" } });
    }
    if (/\/v1beta\/files\/f\d+$/.test(u) && call.method === "GET") {
      return Response.json({ name: u.split("/v1beta/")[1], uri: u.replace("/v1beta/", "/uri/"), state: "ACTIVE" });
    }
    if (call.method === "DELETE") return new Response("{}");
    if (u.includes(":generateContent")) return answer(generates++, call.body as Record<string, unknown>);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { impl, calls };
}

const clipsResponse = (clips: unknown[], usage = { promptTokenCount: 10_000, candidatesTokenCount: 500, promptTokensDetails: [{ modality: "VIDEO", tokenCount: 6000 }, { modality: "AUDIO", tokenCount: 2000 }, { modality: "TEXT", tokenCount: 2000 }] }) =>
  Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ clips }) }] }, finishReason: "STOP" }], usageMetadata: usage });

const SEGMENTS: TranscriptSegment[] = [
  { startSeconds: 30, endSeconds: 40, text: "El dato más loco del stream." },
  { startSeconds: 640, endSeconds: 650, text: "Esto pasa en la segunda parte." },
];

const analyzer = (impl: typeof fetch, model = "gemini-3.5-flash") =>
  new GeminiAnalyzer({ apiKey: "AIza-test", model, mediaResolution: "low", fetch: impl, sleep: async () => undefined, pollMs: 1 });

describe("Gemini: elegir momentos mirando el video", () => {
  it("sube cada parte, espera a que esté lista, pide clips en JSON y pasa los tiempos al video original", async () => {
    const { impl, calls } = fakeGoogle((i) =>
      i === 0
        ? clipsResponse([{ start_seconds: 28, end_seconds: 58, title: "«El dato más loco»", score: 92, reason: "Dato sorprendente con cierre." }])
        : clipsResponse([{ start_seconds: 35, end_seconds: 70, title: "Segunda parte", score: 70, reason: "Reacción fuerte." }]),
    );
    const result = await analyzer(impl).analyzeVideo(
      [
        { path: partA, offsetSeconds: 0, durationSeconds: 660 },
        { path: partB, offsetSeconds: 600, durationSeconds: 300 },
      ],
      SEGMENTS,
      900,
      30,
    );
    expect(result.highlights).toEqual([
      { startSeconds: 28, endSeconds: 58, strength: 0.92, title: "El dato más loco", reason: "Dato sorprendente con cierre." },
      { startSeconds: 635, endSeconds: 670, strength: 0.7, title: "Segunda parte", reason: "Reacción fuerte." },
    ]);

    const generate = calls.filter((c) => c.url.includes(":generateContent"));
    expect(generate[0]!.url).toContain("/v1beta/models/gemini-3.5-flash:generateContent");
    expect(generate[0]!.headers["x-goog-api-key"]).toBe("AIza-test");
    const body = generate[0]!.body as {
      contents: { parts: { fileData?: { fileUri: string }; text?: string }[] }[];
      generationConfig: { mediaResolution: string; responseMimeType: string };
    };
    expect(body.generationConfig).toMatchObject({ mediaResolution: "MEDIA_RESOLUTION_LOW", responseMimeType: "application/json" });
    expect(body.contents[0]!.parts[0]!.fileData!.fileUri).toMatch(/\/uri\/files\/f\d$/); // la del archivo ya procesado
    // La transcripción va con los tiempos de la parte (la segunda empieza en 600 s del original).
    const texts = generate.map((g) => (g.body as typeof body).contents[0]!.parts[1]!.text!);
    expect(texts.some((t) => t.includes("[30.0-40.0] El dato más loco del stream."))).toBe(true);
    expect(texts.some((t) => t.includes("[40.0-50.0] Esto pasa en la segunda parte."))).toBe(true);
    // Los archivos subidos se borran al terminar.
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(2);
    // Costo: video y texto al precio de entrada, audio aparte, salida aparte (x2 partes).
    const one = (8000 * 1.5 + 2000 * 1.5 + 500 * 9) / 1_000_000;
    expect(result.usage.estimatedCostUsd).toBeCloseTo(one * 2, 10);
  });

  it("reintenta el límite de velocidad y usa las partes que salen bien", async () => {
    const { impl } = fakeGoogle((i) =>
      i === 0
        ? Response.json({ error: { status: "RESOURCE_EXHAUSTED", details: [{ retryDelay: "2s" }] } }, { status: 429 })
        : clipsResponse([{ start_seconds: 10, end_seconds: 40, title: "Uno", score: 80, reason: "x" }]),
    );
    const result = await analyzer(impl).analyzeVideo([{ path: partA, offsetSeconds: 0, durationSeconds: 300 }], [], 300);
    expect(result.highlights).toHaveLength(1);
  });

  it("si todas las partes fallan, avisa con un mensaje claro", async () => {
    const { impl } = fakeGoogle(() => Response.json({ error: { status: "NOT_FOUND" } }, { status: 404 }));
    const error = await analyzer(impl, "gemini-x").analyzeVideo([{ path: partA, offsetSeconds: 0, durationSeconds: 300 }], [], 300).catch((e) => e);
    expect(error.message).toBe("Ese modelo de Gemini no está disponible para tu cuenta");
  });

  it("precios por modelo: Flash-Lite es mucho más barato", () => {
    const usage = { promptTokenCount: 1_000_000, candidatesTokenCount: 0, promptTokensDetails: [{ modality: "AUDIO", tokenCount: 0 }] };
    expect(geminiCost(usage, geminiPrices("gemini-3.5-flash")).estimatedCostUsd).toBeCloseTo(1.5);
    expect(geminiCost(usage, geminiPrices("gemini-3.1-flash-lite")).estimatedCostUsd).toBeCloseTo(0.25);
  });
});

/** OpenAI de prueba (respaldo): cuenta llamadas. */
function fakeOpenAI(name = "openai") {
  const calls: string[] = [];
  const provider: AIAnalysisProvider = {
    name,
    transcriptionModel: name === "groq" ? "whisper-large-v3" : "whisper-1",
    async transcribe() {
      calls.push(`${name}:transcribe`);
      if (name === "groq-roto") throw new Error("groq caído");
      return { segments: SEGMENTS, language: "spanish", usage: { audioSeconds: 60, estimatedCostUsd: 0.001 } };
    },
    async analyze() {
      calls.push(`${name}:analyze`);
      return { highlights: [{ startSeconds: 30, endSeconds: 60, strength: 0.6 }], usage: {} };
    },
    async generateClipSuggestions(_s, moments) {
      return { titles: moments.map(() => "t"), usage: {} };
    },
  };
  return { provider, calls };
}

describe("pipeline nuevo: Groq + Gemini, con OpenAI de respaldo", () => {
  it("transcribe con Groq y, si falla, con OpenAI", async () => {
    const openai = fakeOpenAI();
    const brokenGroq = fakeOpenAI("groq-roto");
    const { impl } = fakeGoogle(() => clipsResponse([]));
    const ai = new GeminiPipelineAI({ groq: brokenGroq.provider, openai: openai.provider, gemini: analyzer(impl), log: { warn: () => undefined } });
    const result = await ai.transcribe([]);
    expect(result.provider).toBe("openai:whisper-1");
    expect(brokenGroq.calls).toEqual(["groq-roto:transcribe"]);

    const groq = fakeOpenAI("groq");
    const ok = new GeminiPipelineAI({ groq: groq.provider, openai: openai.provider, gemini: analyzer(impl), log: { warn: () => undefined } });
    expect((await ok.transcribe([])).provider).toBe("groq:whisper-large-v3");
    expect(ok.name).toBe("groq");
  });

  it("si Gemini falla, elige los momentos gpt-4o-mini con la transcripción y lo registra", async () => {
    const openai = fakeOpenAI();
    const { impl } = fakeGoogle(() => Response.json({ error: { status: "INTERNAL" } }, { status: 500 }));
    const warnings: string[] = [];
    const ai = new GeminiPipelineAI({ groq: null, openai: openai.provider, gemini: analyzer(impl), log: { warn: (_o, m) => void warnings.push(m) } });
    const result = await ai.analyze(SEGMENTS, 900, { videoParts: [{ path: partA, offsetSeconds: 0, durationSeconds: 900 }] });
    expect(result.provider).toBe("openai:analysis");
    expect(result.fallbackReason).toBe("Gemini tuvo un error temporal (500)");
    expect(openai.calls).toContain("openai:analyze");
    expect(warnings).toContain("Gemini falló; los momentos se eligen con OpenAI");
  });
});
