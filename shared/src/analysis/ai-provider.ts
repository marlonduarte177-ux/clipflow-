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

/** Una parte del video en baja resolución para que la IA la vea (imagen + audio). */
export interface VideoPart {
  path: string;
  /** Segundo del video original en que empieza esta parte. */
  offsetSeconds: number;
  durationSeconds: number;
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
  /**
   * Si es true, `analyze` aprovecha el video (imagen + audio) en `options.videoParts`: el procesador
   * prepara esas partes en baja resolución. También puede elegir momentos sin habla.
   */
  readonly watchesVideo?: boolean;
  /** Transcribe el audio con tiempos por frase. `provider`: quién transcribió de verdad (p. ej. "groq:whisper-large-v3"). */
  transcribe(
    chunks: AudioChunk[],
  ): Promise<{ segments: TranscriptSegment[]; language: string | null; usage: AIUsage; provider?: string }>;
  /** Lee la transcripción y marca los mejores momentos por su contenido. */
  /** `targetClipSeconds`: duración que eligió el usuario, como guía del largo de cada momento. */
  analyze(
    segments: TranscriptSegment[],
    durationSeconds: number,
    options?: { targetClipSeconds?: number; videoParts?: VideoPart[] },
  ): Promise<{ highlights: ContentHighlight[]; usage: AIUsage; provider?: string; fallbackReason?: string }>;
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
