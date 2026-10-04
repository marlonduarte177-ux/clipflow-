import type {
  AIAnalysisProvider,
  AIUsage,
  AudioChunk,
  ContentHighlight,
  TranscriptSegment,
  VideoPart,
} from "@clipflow/shared";
import type { GeminiAnalyzer } from "./gemini.js";

type Log = { warn: (obj: Record<string, unknown>, msg: string) => void };

/**
 * Pipeline nuevo:
 * - Transcribe con Groq (Whisper large v3, con tiempos por palabra). Si Groq falla, OpenAI Whisper.
 * - Elige los momentos con Gemini mirando el video (imagen + audio) y la transcripción. Si Gemini
 *   falla, gpt-4o-mini con la transcripción (como el pipeline actual).
 * - Títulos de los clips que no traen uno de Gemini y análisis de imágenes: OpenAI.
 */
export class GeminiPipelineAI implements AIAnalysisProvider {
  readonly watchesVideo = true;

  constructor(
    private readonly parts: {
      /** Groq (puede faltar si no hay clave: se usa directamente OpenAI). */
      groq: AIAnalysisProvider | null;
      openai: AIAnalysisProvider;
      gemini: GeminiAnalyzer;
      log: Log;
    },
  ) {}

  /** La transcripción se guarda con el nombre de quien transcribe primero (Groq si hay clave). */
  get name(): string {
    return this.parts.groq?.name ?? this.parts.openai.name;
  }

  get transcriptionModel(): string | undefined {
    return (this.parts.groq ?? this.parts.openai).transcriptionModel;
  }

  async transcribe(chunks: AudioChunk[]) {
    const { groq, openai } = this.parts;
    if (groq) {
      try {
        const result = await groq.transcribe(chunks);
        return { ...result, provider: `groq:${groq.transcriptionModel}` };
      } catch (err) {
        this.parts.log.warn({ error: (err as Error).message }, "Groq falló; se transcribe con OpenAI");
      }
    }
    const result = await openai.transcribe(chunks);
    return { ...result, provider: `openai:${openai.transcriptionModel}` };
  }

  async analyze(
    segments: TranscriptSegment[],
    durationSeconds: number,
    options: { targetClipSeconds?: number; videoParts?: VideoPart[] } = {},
  ): Promise<{ highlights: ContentHighlight[]; usage: AIUsage; provider?: string; fallbackReason?: string }> {
    const { gemini, openai } = this.parts;
    let fallbackReason: string | undefined;
    if (options.videoParts?.length) {
      try {
        const result = await gemini.analyzeVideo(options.videoParts, segments, durationSeconds, options.targetClipSeconds);
        return { ...result, provider: `gemini:${gemini.model}` };
      } catch (err) {
        fallbackReason = (err as Error).message;
        this.parts.log.warn({ error: fallbackReason }, "Gemini falló; los momentos se eligen con OpenAI");
      }
    } else {
      fallbackReason = "sin partes de video";
    }
    // Sin habla, OpenAI no tiene con qué elegir: que el procesador use las señales.
    if (segments.length === 0) return { highlights: [], usage: {}, provider: "none", fallbackReason };
    const result = await openai.analyze(segments, durationSeconds, { targetClipSeconds: options.targetClipSeconds });
    return { ...result, provider: "openai:analysis", fallbackReason };
  }

  analyzeFrames(...args: Parameters<NonNullable<AIAnalysisProvider["analyzeFrames"]>>) {
    if (!this.parts.openai.analyzeFrames) throw new Error("análisis de imágenes no disponible");
    return this.parts.openai.analyzeFrames(...args);
  }

  generateClipSuggestions(segments: TranscriptSegment[], moments: { startSeconds: number; endSeconds: number }[]) {
    return this.parts.openai.generateClipSuggestions(segments, moments);
  }
}
