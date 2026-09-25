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

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
  };
}
