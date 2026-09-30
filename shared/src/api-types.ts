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

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
  };
}
