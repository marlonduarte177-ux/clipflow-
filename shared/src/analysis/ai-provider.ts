import type { SignalSeries } from "./scoring.js";

/**
 * Punto único de conexión con un proveedor de IA (OpenAI en la Fase 8).
 * El resto del sistema solo conoce esta interfaz: cambiar de proveedor no toca el worker.
 */
export interface TranscriptSegment {
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export interface AIUsage {
  audioSeconds?: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
}

export interface AIAnalysisProvider {
  /** Nombre para logs y registros de consumo. */
  readonly name: string;
  /** Transcribe el audio (archivo local ya extraído y comprimido por el worker). */
  transcribe(audioPath: string, durationSeconds: number): Promise<{ segments: TranscriptSegment[]; usage: AIUsage }>;
  /** Convierte la transcripción en señales por segundo (p. ej. "speech"). */
  analyze(segments: TranscriptSegment[], durationSeconds: number): Promise<{ signals: SignalSeries; usage: AIUsage }>;
  /** Propone títulos para los momentos elegidos. */
  generateClipSuggestions(
    segments: TranscriptSegment[],
    moments: { startSeconds: number; endSeconds: number }[],
  ): Promise<{ titles: (string | null)[]; usage: AIUsage }>;
}
