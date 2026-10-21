/** Tipos de las respuestas de la API, compartidos entre backend y frontend. */

export interface MeResponse {
  /** Identificador interno del usuario en ClipFlow. */
  userId: string;
  email: string | null;
  /** Créditos disponibles, en minutos de video (1 crédito = 1 minuto). */
  creditMinutes: number;
}

export interface ProjectDto {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectListResponse {
  projects: ProjectDto[];
}

export type VideoStatus = "pending_upload" | "importing" | "uploaded" | "ready" | "rejected" | "deleted";

export interface VideoDto {
  id: string;
  projectId: string;
  status: VideoStatus;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  /** Duración real (ffprobe) o, mientras no exista, la que informó el navegador. */
  durationSeconds: number | null;
  rejectionReason: string | null;
  createdAt: string;
  uploadedAt: string | null;
  /** Miniatura del mejor clip (URL temporal), si ya hay clips. */
  thumbnailUrl?: string | null;
  /** Clips listos (sin contar los descartados). */
  clipCount?: number;
  /** Enlace de origen, si se importó por enlace. */
  sourceUrl?: string | null;
}

/** Respuesta al importar un video por enlace. */
export interface ImportVideoResponse {
  video: VideoDto;
  job: JobDto;
}

/** Datos de un enlace antes de importarlo (sin descargar el video). */
export interface LinkPreview {
  platform: "TikTok" | "Instagram" | "Facebook" | "Kick" | "Twitch";
  title: string | null;
  /** Imagen de la plataforma (la carga el navegador). */
  thumbnailUrl: string | null;
  /** null si la plataforma no la informa (p. ej. TikTok o Instagram: videos cortos). */
  durationSeconds: number | null;
}

/** URL temporal para bajar el video original. */
export interface VideoDownloadResponse {
  url: string;
  expiresInSeconds: number;
}

export interface VideoListResponse {
  videos: VideoDto[];
}

/** Respuesta al crear un video: cómo dividir el archivo para subirlo directo a S3. */
export interface CreateVideoResponse {
  video: VideoDto;
  upload: {
    partSizeBytes: number;
    partCount: number;
  };
}

export interface UploadPartUrlsResponse {
  urls: { partNumber: number; url: string }[];
  expiresInSeconds: number;
}

export type JobStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";
export type JobStageName = "downloading" | "preparing" | "analyzing" | "detecting_moments" | "rendering_clips" | "finalizing";

export interface JobDto {
  id: string;
  videoId: string;
  type: "analyze_video" | "render_clip" | "export_clip";
  status: JobStatus;
  stage: JobStageName | null;
  /** Progreso real 0–100 escrito por el worker. */
  progress: number;
  attempts: number;
  maxAttempts: number;
  /** Mensaje apto para el usuario si falló. */
  errorMessage: string | null;
  /** Código del error (p. ej. "no_minutes": no alcanzaban los minutos y hay que elegir un tramo). */
  errorCode: string | null;
  params: JobParams;
  result: JobResult | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** "highlight": palabra que suena en color (estilo TikTok); "classic": frase en caja; "none": sin subtítulos en el video. */
export type SubtitleStyle = "highlight" | "classic" | "none";

/**
 * Versión del análisis con IA: "classic" = la actual (GPT lee la transcripción); "v2" = modelo de gama
 * alta que además oye los sonidos (risas, gritos…) y ve fotogramas del video.
 */
export type AnalysisPipeline = "classic" | "v2";

export interface JobParams {
  clipDurationSeconds?: number;
  subtitleStyle?: SubtitleStyle;
  /** Importación "solo descargar": se baja el video y no se crean clips. */
  downloadOnly?: boolean;
  /** Versión del análisis de este trabajo (solo la pone la prueba lado a lado). Sin valor: la del servidor. */
  pipeline?: AnalysisPipeline;
  /** Prueba lado a lado a la que pertenece este trabajo. */
  comparisonId?: string;
  /** No reutilizar transcripciones guardadas (la prueba lado a lado mide el costo real de cada versión). */
  skipTranscriptCache?: boolean;
  /**
   * Tramo del video a procesar, en segundos desde el inicio (pantalla «Duración del video»). Sin valor:
   * el video completo. Solo se descuentan los minutos del tramo y, si es un enlace, solo se baja ese tramo.
   */
  rangeStartSeconds?: number;
  rangeEndSeconds?: number;
  /**
   * Editor de clips (solo administradores por ahora): guardar cada clip también sin subtítulos
   * dibujados, con sus palabras y sonidos, para poder editarlo después.
   */
  editable?: boolean;
  /**
   * Calidad HD: menos ruido, nitidez suave, escalado lanczos, un poco más de contraste y color, y
   * CRF 18. Por ahora solo en trabajos de administradores (activada por defecto).
   */
  hd?: boolean;
  /** Trabajo de edición ("render_clip"): los clips a editar y cómo. */
  clipIds?: string[];
  edit?: ClipEditOptions;
}

/** Cómo se edita un clip. "viral": subtítulos karaoke, zoom golpe, temblor y flash, música, 60 fps. */
export interface ClipEditOptions {
  mode: "viral";
  /** Música de fondo a volumen bajo (si hay pistas cargadas). */
  music: boolean;
  /** Calidad HD (activada por defecto). */
  hd?: boolean;
}

/** Datos guardados de un clip para editarlo (palabras y sonidos con tiempos relativos al clip). */
export interface ClipEditData {
  version: 1;
  durationSeconds: number;
  /** El clip limpio ya se hizo con calidad HD. */
  hd?: boolean;
  words: { startSeconds: number; endSeconds: number; text: string }[];
  sounds: { kind: string; startSeconds: number; endSeconds: number; confidence: number }[];
}

export interface JobResult {
  /** Clips generados (en un trabajo de edición: clips editados). */
  clipCount: number;
  /** Fue una importación "solo descargar": el video quedó listo para bajarlo, sin clips. */
  downloadOnly?: boolean;
  /**
   * "used": hubo análisis de IA; "no_speech": se transcribió pero no hay habla (p. ej. gameplay);
   * "disabled": no hay clave; "unavailable": la IA falló; "no_audio": el video no tiene audio.
   */
  ai: "used" | "no_speech" | "disabled" | "unavailable" | "no_audio";
  aiReason?: string;
  /** Versión del análisis que se usó y sus modelos. */
  pipeline?: AnalysisPipeline;
  models?: { transcription?: string; analysis?: string };
  /** Versión nueva: sonidos detectados por tipo (risas, gritos, aplausos, vítores). */
  sounds?: Partial<Record<"laughter" | "scream" | "applause" | "cheer", number>>;
  /** Versión nueva: fotogramas que vio la IA. */
  analysisFrames?: number;
  language?: string | null;
  /** Cómo se eligieron los momentos: "ai" = los eligió la IA (videos con voz); "signals" = por volumen, acción y movimiento. */
  selection?: "ai" | "signals";
  /** Análisis de imágenes con IA (experimental). */
  vision?: "used" | "disabled" | "unavailable";
  /** Por qué no se pudo usar el análisis de imágenes, o si quedó incompleto. */
  visionReason?: string;
  visionFrames?: number;
  /** Chat del VOD de Twitch como señal extra: "used" si se leyó, "unavailable" si no se pudo. */
  chat?: "used" | "unavailable";
  /** Mensajes del chat leídos (muestra). */
  chatMessages?: number;
  /** Costo estimado de ESTE procesamiento, en USD. */
  costs?: {
    transcriptionUsd: number;
    textUsd: number;
    visionUsd: number;
    computeUsd: number;
    totalUsd: number;
  };
}

export interface JobListResponse {
  jobs: JobDto[];
}

export type ClipStatus = "generated" | "approved" | "discarded";

export interface ClipDto {
  id: string;
  videoId: string;
  status: ClipStatus;
  title: string | null;
  startSeconds: number;
  endSeconds: number;
  aspectRatio: "9:16" | "1:1" | "16:9" | "original";
  score: number | null;
  scoreBreakdown: Record<string, number> | null;
  /** URLs firmadas temporales (null si el archivo aún no existe). */
  videoUrl: string | null;
  thumbnailUrl: string | null;
  /** Subtítulos del clip (si hubo transcripción). */
  subtitlesVttUrl: string | null;
  subtitlesSrtUrl: string | null;
  /** Editor de clips: se puede editar (tiene copia sin subtítulos o se puede rehacer del original). */
  editable?: boolean;
  /** Última versión editada (URL temporal) y con qué opciones. */
  editedVideoUrl?: string | null;
  edit?: (ClipEditOptions & { at: string; jobId: string }) | null;
  createdAt: string;
}

export interface ClipListResponse {
  clips: ClipDto[];
  urlsExpireInSeconds: number;
  /** Transcripción completa del video (WebVTT, URL temporal) y su idioma, si la hay. */
  transcript?: { vttUrl: string; language: string | null } | null;
}

/** Mensaje de la cola: solo el id; los datos viven en la base. */
export interface JobQueueMessage {
  jobId: string;
}

/**
 * Aviso de "enciende el procesador": se envía cuando empieza una subida para que el worker
 * arranque mientras el video sube. No es un trabajo.
 */
export interface WarmupQueueMessage {
  warmup: true;
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
  };
}
