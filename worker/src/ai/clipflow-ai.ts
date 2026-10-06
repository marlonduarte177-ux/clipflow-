import type { AIAnalysisProvider, AudioChunk, FrameSheet, TranscriptSegment } from "@clipflow/shared";
import type { AssemblyAITranscriber } from "./assemblyai.js";

/**
 * IA de ClipFlow: AssemblyAI transcribe (frases y tiempos por palabra) y GPT de OpenAI elige los
 * momentos, propone títulos y (si está activo) analiza imágenes. Sin respaldo de transcripción.
 */
export class ClipFlowAI implements AIAnalysisProvider {
  readonly name = "assemblyai";

  constructor(
    private readonly transcriber: AssemblyAITranscriber,
    private readonly gpt: AIAnalysisProvider,
  ) {}

  get transcriptionModel(): string {
    return this.transcriber.model;
  }

  transcribe(chunks: AudioChunk[]) {
    return this.transcriber.transcribe(chunks);
  }

  analyze(segments: TranscriptSegment[], durationSeconds: number, options?: { targetClipSeconds?: number }) {
    return this.gpt.analyze(segments, durationSeconds, options);
  }

  analyzeFrames(sheets: FrameSheet[], options?: { deadline?: number }) {
    if (!this.gpt.analyzeFrames) throw new Error("análisis de imágenes no disponible");
    return this.gpt.analyzeFrames(sheets, options);
  }

  generateClipSuggestions(segments: TranscriptSegment[], moments: { startSeconds: number; endSeconds: number }[]) {
    return this.gpt.generateClipSuggestions(segments, moments);
  }
}
