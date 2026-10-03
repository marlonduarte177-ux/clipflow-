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
  params: JobParams;
  result: JobResult | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** "highlight": palabra que suena en color (estilo TikTok); "classic": frase en caja; "none": sin subtítulos en el video. */
export type SubtitleStyle = "highlight" | "classic" | "none";

export interface JobParams {
  clipDurationSeconds?: number;
  subtitleStyle?: SubtitleStyle;
  /** Importación "solo descargar": se baja el video y no se crean clips. */
  downloadOnly?: boolean;
}

export interface JobResult {
  clipCount: number;
  /** Fue una importación "solo descargar": el video quedó listo para bajarlo, sin clips. */
  downloadOnly?: boolean;
  /**
   * "used": hubo análisis de IA; "no_speech": se transcribió pero no hay habla (p. ej. gameplay);
   * "disabled": no hay clave; "unavailable": la IA falló; "no_audio": el video no tiene audio.
   */
  ai: "used" | "no_speech" | "disabled" | "unavailable" | "no_audio";
  aiReason?: string;
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
