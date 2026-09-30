/** Tipos de las respuestas de la API, compartidos entre backend y frontend. */

export interface MeResponse {
  /** Identificador interno del usuario en ClipFlow. */
  userId: string;
  email: string | null;
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

export type VideoStatus = "pending_upload" | "uploaded" | "ready" | "rejected" | "deleted";

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
export type JobStageName = "preparing" | "analyzing" | "detecting_moments" | "rendering_clips" | "finalizing";

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
  params: { clipDurationSeconds?: number };
  result: JobResult | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface JobResult {
  clipCount: number;
  /**
   * "used": hubo análisis de IA; "no_speech": se transcribió pero no hay habla (p. ej. gameplay);
   * "disabled": no hay clave; "unavailable": la IA falló; "no_audio": el video no tiene audio.
   */
  ai: "used" | "no_speech" | "disabled" | "unavailable" | "no_audio";
  aiReason?: string;
  language?: string | null;
  /** Análisis de imágenes con IA (experimental). */
  vision?: "used" | "disabled" | "unavailable";
  visionFrames?: number;
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
}

/** Mensaje de la cola: solo el id; los datos viven en la base. */
export interface JobQueueMessage {
  jobId: string;
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
  };
}
