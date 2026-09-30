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

/** Un trozo de audio ya extraído y comprimido por el worker. */
export interface AudioChunk {
  path: string;
  /** Segundo del video en que empieza este trozo. */
  offsetSeconds: number;
  durationSeconds: number;
}

/** Momento destacado según el contenido (lo que se dice). */
export interface ContentHighlight {
  startSeconds: number;
  endSeconds: number;
  /** 0–1: qué tan buen clip sería. */
  strength: number;
  reason?: string;
}

export interface AIAnalysisProvider {
  /** Nombre para logs y registros de consumo. */
  readonly name: string;
  /** Transcribe el audio con tiempos por frase. */
  transcribe(chunks: AudioChunk[]): Promise<{ segments: TranscriptSegment[]; language: string | null; usage: AIUsage }>;
  /** Lee la transcripción y marca los mejores momentos por su contenido. */
  analyze(segments: TranscriptSegment[], durationSeconds: number): Promise<{ highlights: ContentHighlight[]; usage: AIUsage }>;
  /** Propone títulos para los momentos elegidos. */
  generateClipSuggestions(
    segments: TranscriptSegment[],
    moments: { startSeconds: number; endSeconds: number }[],
  ): Promise<{ titles: (string | null)[]; usage: AIUsage }>;
}
