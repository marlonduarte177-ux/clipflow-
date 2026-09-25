/** Tipos de las respuestas de la API, compartidos entre backend y frontend. */

export interface MeResponse {
  /** Identificador del usuario en Cognito (`sub`). */
  userId: string;
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
  };
}
