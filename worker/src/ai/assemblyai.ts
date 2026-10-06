import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { AIUsage, AudioChunk, TranscriptSegment, TranscriptWord } from "@clipflow/shared";
import { AIProviderError } from "./openai.js";

export interface AssemblyAIOptions {
  apiKey: string;
  /** Modelos en orden de preferencia (p. ej. ["universal-3-5-pro", "universal-2"]). */
  speechModels: string[];
  /** USD por hora de audio (para estimar costos). */
  costPerHourUsd: number;
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Cada cuánto se pregunta si la transcripción terminó. */
  pollMs?: number;
  /** Tope de espera por trozo (por defecto 30 min). */
  maxWaitMs?: number;
}

const Word = z.object({ text: z.string(), start: z.number(), end: z.number() });
const TranscriptResponse = z.object({
  id: z.string(),
  status: z.string(),
  error: z.string().nullish(),
  language_code: z.string().nullish(),
});
const SentencesResponse = z.object({
  sentences: z.array(z.object({ text: z.string(), start: z.number(), end: z.number(), words: z.array(Word).default([]) })).default([]),
});

/** Una frase larga se parte en trozos de como mucho este largo (subtítulos y cortes más finos). */
const MAX_SEGMENT_SECONDS = 15;

/**
 * Transcripción con AssemblyAI (frases y tiempos por palabra; detecta el idioma solo).
 * Por cada trozo de audio: lo sube, pide la transcripción, espera a que termine, lee las frases
 * con sus palabras y borra la transcripción de AssemblyAI (no queda guardada allá).
 */
export class AssemblyAITranscriber {
  readonly name = "assemblyai";
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: AssemblyAIOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl ?? "https://api.assemblyai.com";
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Nombre del modelo (clave de la transcripción guardada: cambiar de modelo transcribe de nuevo). */
  get model(): string {
    return this.options.speechModels[0] ?? "universal";
  }

  async transcribe(chunks: AudioChunk[]): Promise<{ segments: TranscriptSegment[]; language: string | null; usage: AIUsage }> {
    // Hasta 3 trozos a la vez (un video de 1 h son 6 trozos).
    const results: { segments: TranscriptSegment[]; language: string | null }[] = new Array(chunks.length);
    let next = 0;
    const worker = async () => {
      while (next < chunks.length) {
        const index = next++;
        results[index] = await this.transcribeChunk(chunks[index]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, chunks.length) }, worker));
    const audioSeconds = chunks.reduce((sum, c) => sum + c.durationSeconds, 0);
    return {
      segments: results.flatMap((r) => r.segments),
      language: results.find((r) => r.language)?.language ?? null,
      usage: { audioSeconds, estimatedCostUsd: (audioSeconds / 3600) * this.options.costPerHourUsd },
    };
  }

  private async transcribeChunk(chunk: AudioChunk) {
    const audio = await readFile(chunk.path);
    const upload = z.object({ upload_url: z.string() }).safeParse(
      await this.request("/v2/upload", () => ({
        method: "POST",
        headers: { ...this.headers(), "Content-Type": "application/octet-stream" },
        body: audio,
      })),
    );
    if (!upload.success) throw new AIProviderError("Respuesta inesperada de AssemblyAI", true);

    const submitted = TranscriptResponse.safeParse(
      await this.request("/v2/transcript", () => ({
        method: "POST",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify({
          audio_url: upload.data.upload_url,
          speech_models: this.options.speechModels,
          language_detection: true,
          punctuate: true,
          format_text: true,
        }),
      })),
    );
    if (!submitted.success) throw new AIProviderError("Respuesta inesperada de AssemblyAI", true);
    const id = submitted.data.id;
    try {
      const done = await this.waitUntilDone(id);
      const sentences = SentencesResponse.safeParse(await this.request(`/v2/transcript/${id}/sentences`, () => ({ headers: this.headers() })));
      if (!sentences.success) throw new AIProviderError("Transcripción con formato inesperado", true);
      return { segments: toSegments(sentences.data.sentences, chunk), language: done.language_code ?? null };
    } finally {
      // La transcripción ya está con nosotros: se borra de AssemblyAI (si falla, no frena el trabajo).
      await this.fetchImpl(`${this.baseUrl}/v2/transcript/${id}`, { method: "DELETE", headers: this.headers() }).catch(() => undefined);
    }
  }

  private async waitUntilDone(id: string) {
    const pollMs = this.options.pollMs ?? 3000;
    const deadline = Date.now() + (this.options.maxWaitMs ?? 30 * 60 * 1000);
    for (;;) {
      const parsed = TranscriptResponse.safeParse(await this.request(`/v2/transcript/${id}`, () => ({ headers: this.headers() })));
      if (!parsed.success) throw new AIProviderError("Respuesta inesperada de AssemblyAI", true);
      if (parsed.data.status === "completed") return parsed.data;
      // El detalle de AssemblyAI no se muestra: puede traer datos técnicos del archivo.
      if (parsed.data.status === "error") throw new AIProviderError("AssemblyAI no pudo transcribir el audio", false);
      if (Date.now() > deadline) throw new AIProviderError("AssemblyAI tardó demasiado en transcribir", true);
      await this.sleep(pollMs);
    }
  }

  private headers(): Record<string, string> {
    return { Authorization: this.options.apiKey };
  }

  /** Petición con reintentos para la red, el límite de velocidad (429) y errores 5xx. */
  private async request(pathname: string, init: () => RequestInit): Promise<unknown> {
    const maxAttempts = 4;
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}${pathname}`, { ...init(), signal: AbortSignal.timeout(10 * 60 * 1000) });
      } catch {
        if (attempt >= maxAttempts) throw new AIProviderError("No se pudo conectar con AssemblyAI", true);
        await this.sleep(1000 * 2 ** attempt);
        continue;
      }
      if (res.ok) return res.json();
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= maxAttempts) throw new AIProviderError(describeError(res.status), retryable, res.status);
      await this.sleep(1000 * 2 ** attempt);
    }
  }
}

function describeError(status: number): string {
  if (status === 401 || status === 403) return "La clave de AssemblyAI no es válida";
  if (status === 402) return "Tu cuenta de AssemblyAI no tiene saldo (revisa Billing en assemblyai.com)";
  if (status === 429) return "AssemblyAI está saturado por ahora";
  if (status >= 500) return `AssemblyAI tuvo un error temporal (${status})`;
  return `AssemblyAI rechazó la solicitud (${status})`;
}

/**
 * Frases de AssemblyAI (tiempos en ms, desde el inicio del trozo) → segmentos del video (segundos).
 * Las frases muy largas se parten en la pausa o coma más cercana para no superar ~15 s.
 */
export function toSegments(
  sentences: { text: string; start: number; end: number; words: { text: string; start: number; end: number }[] }[],
  chunk: Pick<AudioChunk, "offsetSeconds" | "durationSeconds">,
): TranscriptSegment[] {
  const at = (ms: number) => chunk.offsetSeconds + Math.min(ms / 1000, chunk.durationSeconds);
  const segments: TranscriptSegment[] = [];
  for (const sentence of sentences) {
    const words: TranscriptWord[] = sentence.words
      .filter((w) => w.text.trim() !== "" && w.end >= w.start)
      .map((w) => ({ startSeconds: at(w.start), endSeconds: at(w.end), text: w.text.trim() }));
    if (words.length === 0) {
      if (sentence.text.trim() && sentence.end > sentence.start) {
        segments.push({ startSeconds: at(sentence.start), endSeconds: at(sentence.end), text: sentence.text.trim() });
      }
      continue;
    }
    let piece: TranscriptWord[] = [];
    const flush = () => {
      if (piece.length === 0) return;
      segments.push({
        startSeconds: piece[0]!.startSeconds,
        endSeconds: piece[piece.length - 1]!.endSeconds,
        text: piece.map((w) => w.text).join(" "),
        words: piece,
      });
      piece = [];
    };
    for (const word of words) {
      piece.push(word);
      const length = word.endSeconds - piece[0]!.startSeconds;
      // Pasados 8 s se corta en la primera coma; pasados 15 s, donde sea.
      if ((length >= 8 && /[,;:]$/.test(word.text)) || length >= MAX_SEGMENT_SECONDS) flush();
    }
    flush();
  }
  return segments;
}
