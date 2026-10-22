/**
 * Rutas fijas en S3 que comparten la API y el worker.
 * (Las de clips, miniaturas y subtítulos por clip se guardan en la base de datos.)
 */

/**
 * Transcripción guardada de un VIDEO (JSON), para reutilizarla al reintentar o volver a procesar sin
 * pagarla otra vez. Una por usuario, video y modelo: nunca se mezclan. Se borra con el video.
 */
export function transcriptCacheKey(userId: string, videoId: string, provider: string, model: string): string {
  const safe = `${provider}-${model}`.replace(/[^\w.-]+/g, "_");
  return `transcripts/${userId}/${videoId}/${safe}.json`;
}

/** Transcripción completa de un procesamiento (WebVTT), dentro de la carpeta de subtítulos del trabajo. */
export function fullTranscriptKey(userId: string, jobId: string): string {
  return `subtitles/${userId}/${jobId}/full.vtt`;
}
