/**
 * Rutas fijas en S3 que comparten la API y el worker.
 * (Las de clips, miniaturas y subtítulos por clip se guardan en la base de datos.)
 */

/** Transcripción completa de un procesamiento (WebVTT), dentro de la carpeta de subtítulos del trabajo. */
export function fullTranscriptKey(userId: string, jobId: string): string {
  return `subtitles/${userId}/${jobId}/full.vtt`;
}
