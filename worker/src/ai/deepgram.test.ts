import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AIAnalysisProvider } from "@clipflow/shared";
import { DeepgramTranscriber, looksLikeDeepgramKey, withDeepgram, wordsToSegments } from "./deepgram.js";
import { AIProviderError } from "./openai.js";

const dir = mkdtempSync(path.join(tmpdir(), "deepgram-test-"));
const chunk = path.join(dir, "audio-001.mp3");
writeFileSync(chunk, "fake-mp3");

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const w = (word: string, start: number, end: number) => ({ word: word.toLowerCase().replace(/[^\p{L}]/gu, ""), punctuated_word: word, start, end, confidence: 0.99 });

describe("transcripción con Deepgram", () => {
  it("envía el audio con la clave y arma frases con el tiempo de cada palabra, corridas al lugar del trozo", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return json({
        results: {
          channels: [
            {
              detected_language: "es",
              alternatives: [{ words: [w("Hola", 0.1, 0.4), w("mundo.", 0.5, 0.9), w("¿Qué", 1.0, 1.2), w("tal?", 1.3, 1.6)] }],
            },
          ],
        },
      });
    }) as typeof fetch;
    const dg = new DeepgramTranscriber({ apiKey: "a".repeat(40), model: "nova-3", costPerMinuteUsd: 0.0043, fetch: fetchImpl });
    const result = await dg.transcribe([{ path: chunk, offsetSeconds: 600, durationSeconds: 120 }]);
    expect(result.language).toBe("es");
    expect(result.segments).toEqual([
      {
        startSeconds: 600.1,
        endSeconds: 600.9,
        text: "Hola mundo.",
        words: [
          { startSeconds: 600.1, endSeconds: 600.4, text: "Hola" },
          { startSeconds: 600.5, endSeconds: 600.9, text: "mundo." },
        ],
      },
      {
        startSeconds: 601,
        endSeconds: 601.6,
        text: "¿Qué tal?",
        words: [
          { startSeconds: 601, endSeconds: 601.2, text: "¿Qué" },
          { startSeconds: 601.3, endSeconds: 601.6, text: "tal?" },
        ],
      },
    ]);
    expect(result.usage.audioSeconds).toBe(120);
    expect(result.usage.estimatedCostUsd).toBeCloseTo(2 * 0.0043);
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe("https://api.deepgram.com/v1/listen");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ model: "nova-3", smart_format: "true", detect_language: "true" });
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Token ${"a".repeat(40)}`);
    expect((calls[0]!.init.headers as Record<string, string>)["Content-Type"]).toBe("audio/mpeg");
  });

  it("corta frases en pausas largas y en las muy largas aunque no haya punto", () => {
    const words = [
      { startSeconds: 0, endSeconds: 0.5, text: "uno" },
      { startSeconds: 2, endSeconds: 2.5, text: "dos" }, // pausa de 1,5 s
      ...Array.from({ length: 20 }, (_, i) => ({ startSeconds: 3 + i, endSeconds: 3.8 + i, text: `p${i}` })),
    ];
    const segments = wordsToSegments(words);
    expect(segments[0]!.text).toBe("uno");
    expect(segments.every((s) => s.endSeconds - s.startSeconds <= 15)).toBe(true);
    expect(segments.flatMap((s) => s.words!.map((x) => x.text))).toEqual(words.map((x) => x.text));
  });

  it("una clave inválida no se reintenta; un error temporal sí", async () => {
    let n = 0;
    const bad = new DeepgramTranscriber({ apiKey: "a".repeat(40), model: "nova-3", costPerMinuteUsd: 0, fetch: (async () => (n++, json({}, 401))) as typeof fetch, sleep: async () => undefined });
    const error = await bad.transcribe([{ path: chunk, offsetSeconds: 0, durationSeconds: 10 }]).catch((e) => e);
    expect(error).toBeInstanceOf(AIProviderError);
    expect(error).toMatchObject({ message: "La clave de Deepgram no es válida", retryable: false, status: 401 });
    expect(n).toBe(1);

    const replies = [json({}, 503), json({ results: { channels: [{ alternatives: [{ words: [] }] }] } })];
    const flaky = new DeepgramTranscriber({ apiKey: "a".repeat(40), model: "nova-3", costPerMinuteUsd: 0, fetch: (async () => replies.shift()!) as typeof fetch, sleep: async () => undefined });
    expect((await flaky.transcribe([{ path: chunk, offsetSeconds: 0, durationSeconds: 10 }])).segments).toEqual([]);
  });

  it("reconoce la clave y combina Deepgram (transcribe) con GPT (elige momentos)", async () => {
    expect(looksLikeDeepgramKey("0123456789abcdef0123456789abcdef01234567")).toBe(true);
    expect(looksLikeDeepgramKey("Ab3kL9mN2pQ5rS8tU1vW4xY7zA0bC3dE")).toBe(false); // relleno de AWS
    const gpt: AIAnalysisProvider = {
      name: "openai",
      transcriptionModel: "whisper-1",
      analysisModel: "gpt-6.1-sol",
      transcribe: async () => {
        throw new Error("no debería transcribir");
      },
      analyze: async () => ({ highlights: [{ startSeconds: 1, endSeconds: 2, strength: 1 }], usage: {} }),
      generateClipSuggestions: async () => ({ titles: ["t"], usage: {} }),
    };
    const dg = new DeepgramTranscriber({
      apiKey: "a".repeat(40),
      model: "nova-3",
      costPerMinuteUsd: 0,
      fetch: (async () => json({ results: { channels: [{ alternatives: [{ words: [w("Hola.", 0, 1)] }] }] } })) as typeof fetch,
    });
    const both = withDeepgram(gpt, dg);
    expect(both).toMatchObject({ name: "deepgram+openai", transcriptionModel: "deepgram-nova-3", analysisModel: "gpt-6.1-sol" });
    expect((await both.transcribe([{ path: chunk, offsetSeconds: 0, durationSeconds: 5 }])).segments[0]!.text).toBe("Hola.");
    expect((await both.analyze([], 10)).highlights).toHaveLength(1);
  });
});
