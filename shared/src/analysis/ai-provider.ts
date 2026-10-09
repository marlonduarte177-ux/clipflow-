/**
 * Punto único de conexión con un proveedor de IA (OpenAI en la Fase 8).
 * El resto del sistema solo conoce esta interfaz: cambiar de proveedor no toca el worker.
 */
export interface TranscriptWord {
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export interface TranscriptSegment {
  startSeconds: number;
  endSeconds: number;
  text: string;
  /** Tiempos de cada palabra (si el proveedor los da): para resaltar la palabra que suena. */
  words?: TranscriptWord[];
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
  /** Título con gancho que propuso la IA (si lo da, no se pide aparte). */
  title?: string;
}

/** Sonidos que detecta el procesador en el audio (sin costo: modelo local). */
export type SoundKind = "laughter" | "scream" | "applause" | "cheer";

/** Un sonido detectado, con sus tiempos en el video. */
export interface SoundEvent {
  kind: SoundKind;
  startSeconds: number;
  endSeconds: number;
  /** 0–1: qué tan seguro está el detector. */
  confidence: number;
}

/** Un fotograma suelto en baja resolución (JPEG) para que la IA "vea" el video. */
export interface VideoFrame {
  path: string;
  timeSeconds: number;
}

/** Opciones del análisis de momentos. */
export interface AnalyzeOptions {
  /** Duración que eligió el usuario, como guía del largo de cada momento. */
  targetClipSeconds?: number;
  /** Risas, gritos, aplausos y vítores detectados (se marcan en la transcripción). */
  sounds?: SoundEvent[];
  /** Fotogramas en baja resolución, en orden. */
  frames?: VideoFrame[];
}

/** Una hoja con varios fotogramas en cuadrícula (izquierda→derecha, arriba→abajo). */
export interface FrameSheet {
  path: string;
  /** Segundo del video de cada fotograma, en el orden de la cuadrícula. */
  frameTimes: number[];
  columns: number;
  rows: number;
}

/** Puntuación de un fotograma según lo que se ve. */
export interface FrameScore {
  timeSeconds: number;
  /** 0–1: qué tan buen momento de clip se ve. */
  score: number;
  /** Etiqueta corta, p. ej. "Eliminación doble". */
  label: string;
}

export interface AIAnalysisProvider {
  /** Nombre para logs y registros de consumo. */
  readonly name: string;
  /**
   * Modelo de transcripción (p. ej. "whisper-1"). Si existe, la transcripción de cada video se guarda
   * y se reutiliza al reintentar o volver a procesar: no se paga dos veces.
   */
  readonly transcriptionModel?: string;
  /** Modelo que elige los momentos (para registrar qué se usó). */
  readonly analysisModel?: string;
  /** Transcribe el audio con tiempos por frase. */
  transcribe(chunks: AudioChunk[]): Promise<{ segments: TranscriptSegment[]; language: string | null; usage: AIUsage }>;
  /**
   * Lee la transcripción y marca los mejores momentos por su contenido. Con `sounds` y `frames`
   * (versión nueva) también "oye" las reacciones y "ve" el video.
   */
  analyze(
    segments: TranscriptSegment[],
    durationSeconds: number,
    options?: AnalyzeOptions,
  ): Promise<{ highlights: ContentHighlight[]; usage: AIUsage }>;
  /** Analiza fotogramas (opcional: solo proveedores con visión). */
  analyzeFrames?(
    sheets: FrameSheet[],
    options?: { deadline?: number },
  ): Promise<{ frames: FrameScore[]; usage: AIUsage; skippedSheets?: number }>;
  /** Propone títulos para los momentos elegidos. */
  generateClipSuggestions(
    segments: TranscriptSegment[],
    moments: { startSeconds: number; endSeconds: number }[],
  ): Promise<{ titles: (string | null)[]; usage: AIUsage }>;
}
