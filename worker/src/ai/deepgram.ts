import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { AIAnalysisProvider, AIUsage, AudioChunk, TranscriptSegment, TranscriptWord } from "@clipflow/shared";
import { AIProviderError, networkCause } from "./openai.js";

/**
 * Transcripción con Deepgram (Nova-3, audio grabado): frases con tiempos y el tiempo de cada palabra
 * (para resaltar la que suena y cortar en frases completas). Detecta el idioma del audio.
 */
export interface DeepgramOptions {
  apiKey: string;
  model: string;
  /** USD por minuto de audio (Nova-3 grabado: 0,0043 en octubre de 2026). */
  costPerMinuteUsd: number;
  baseUrl?: string;
  fetch?: typeof fetch;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

const Word = z.object({
  word: z.string(),
  punctuated_word: z.string().optional(),
  start: z.number(),
  end: z.number(),
});

const DeepgramResponse = z.object({
  results: z.object({
    channels: z
      .array(
        z.object({
          detected_language: z.string().nullish(),
          alternatives: z.array(z.object({ words: z.array(Word).default([]) })).min(1),
        }),
      )
      .min(1),
  }),
});

/** Una frase nueva después de un punto final o de una pausa larga, y nunca más larga que esto. */
const SENTENCE_PAUSE_SECONDS = 1;
const MAX_SENTENCE_SECONDS = 15;

/**
 * Arma frases con las palabras de Deepgram (como las de Whisper): termina una frase en un punto,
 * signo de pregunta o exclamación, en una pausa de más de 1 s o al pasar de 15 s.
 */
export function wordsToSegments(words: TranscriptWord[]): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let current: TranscriptWord[] = [];
  const close = () => {
    if (!current.length) return;
    segments.push({
      startSeconds: current[0]!.startSeconds,
      endSeconds: current[current.length - 1]!.endSeconds,
      text: current.map((w) => w.text).join(" "),
      words: current,
    });
    current = [];
  };
  for (const word of words) {
    const last = current[current.length - 1];
    if (last && (word.startSeconds - last.endSeconds > SENTENCE_PAUSE_SECONDS || word.endSeconds - current[0]!.startSeconds > MAX_SENTENCE_SECONDS)) {
      close();
    }
    current.push(word);
    if (/[.?!…]["»”')\]]*$/.test(word.text)) close();
  }
  close();
  return segments;
}

export class DeepgramTranscriber {
  readonly name = "deepgram";
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: DeepgramOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl ?? "https://api.deepgram.com/v1";
    this.maxAttempts = options.maxAttempts ?? 6;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get model(): string {
    return this.options.model;
  }

  /** Un pedido con reintentos ante cortes de red, límite de velocidad (429) y errores de Deepgram (5xx). */
  private async listen(audio: Buffer): Promise<unknown> {
    const query = new URLSearchParams({ model: this.options.model, smart_format: "true", punctuate: "true", detect_language: "true" });
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/listen?${query}`, {
          method: "POST",
          headers: { Authorization: `Token ${this.options.apiKey}`, "Content-Type": "audio/mpeg" },
          body: new Uint8Array(audio),
          signal: AbortSignal.timeout(10 * 60 * 1000),
        });
      } catch (err) {
        const error = new AIProviderError("No se pudo conectar con Deepgram", true, undefined, undefined, undefined, networkCause(err));
        if (attempt >= this.maxAttempts) throw error;
        await this.sleep(5000 * 2 ** (attempt - 1));
        continue;
      }
      if (res.ok) return res.json();
      const retryable = res.status === 429 || res.status >= 500;
      const message =
        res.status === 401 || res.status === 403
          ? "La clave de Deepgram no es válida"
          : res.status === 402
            ? "Tu cuenta de Deepgram no tiene saldo (revisa Billing en console.deepgram.com)"
            : res.status === 429
              ? "Deepgram limitó las solicitudes de tu cuenta (límite de velocidad)"
              : res.status >= 500
                ? `Deepgram tuvo un error temporal (${res.status})`
                : `Deepgram rechazó la solicitud (${res.status})`;
      const error = new AIProviderError(message, retryable, res.status);
      if (!retryable || attempt >= this.maxAttempts) throw error;
      await this.sleep(Math.min(60_000, 2000 * 2 ** attempt));
    }
  }

  async transcribe(chunks: AudioChunk[]): Promise<{ segments: TranscriptSegment[]; language: string | null; usage: AIUsage }> {
    const segments: TranscriptSegment[] = [];
    let language: string | null = null;
    for (const chunk of chunks) {
      const parsed = DeepgramResponse.safeParse(await this.listen(await readFile(chunk.path)));
      if (!parsed.success) throw new AIProviderError("Transcripción con formato inesperado", true);
      const channel = parsed.data.results.channels[0]!;
      language ??= channel.detected_language?.trim().toLowerCase() || null;
      const words = channel.alternatives[0]!.words
        .filter((w) => (w.punctuated_word ?? w.word).trim() !== "" && w.end >= w.start)
        .map((w) => ({
          startSeconds: chunk.offsetSeconds + w.start,
          endSeconds: chunk.offsetSeconds + Math.min(w.end, chunk.durationSeconds),
          text: (w.punctuated_word ?? w.word).trim(),
        }));
      segments.push(...wordsToSegments(words));
    }
    const audioSeconds = chunks.reduce((sum, c) => sum + c.durationSeconds, 0);
    return { segments, language, usage: { audioSeconds, estimatedCostUsd: (audioSeconds / 60) * this.options.costPerMinuteUsd } };
  }
}

/** Una clave de Deepgram son 40 caracteres hexadecimales (el valor inicial del secreto en AWS no lo es). */
export function looksLikeDeepgramKey(value: string | undefined): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/i.test(value.trim());
}

/**
 * El mismo proveedor de IA (que elige los momentos y los títulos), pero transcribiendo con Deepgram.
 * La transcripción guardada de cada video queda separada de las de Whisper (otro modelo en la ruta).
 */
export function withDeepgram(provider: AIAnalysisProvider, deepgram: DeepgramTranscriber): AIAnalysisProvider {
  return {
    name: `${deepgram.name}+${provider.name}`,
    transcriptionModel: `deepgram-${deepgram.model}`,
    analysisModel: provider.analysisModel,
    transcribe: (chunks) => deepgram.transcribe(chunks),
    analyze: (segments, duration, options) => provider.analyze(segments, duration, options),
    generateClipSuggestions: (segments, moments) => provider.generateClipSuggestions(segments, moments),
    ...(provider.analyzeFrames ? { analyzeFrames: provider.analyzeFrames.bind(provider) } : {}),
  };
}
