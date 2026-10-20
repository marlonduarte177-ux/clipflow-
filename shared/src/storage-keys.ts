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

/** Editor de clips: el clip sin subtítulos dibujados (junto al clip normal del mismo trabajo). */
export function cleanClipKey(userId: string, jobId: string, index: number): string {
  return `clips/${userId}/${jobId}/${index}-clean.mp4`;
}

/** Editor de clips: palabras y sonidos del clip (JSON, ver `ClipEditData`). */
export function clipEditDataKey(userId: string, jobId: string, index: number): string {
  return `subtitles/${userId}/${jobId}/${index}.edit.json`;
}

/** Versión editada de un clip: en la carpeta del trabajo de edición (se borra con el video). */
export function editedClipKey(userId: string, renderJobId: string, clipId: string): string {
  return `clips/${userId}/${renderJobId}/${clipId}.mp4`;
}

/** Pistas de música libres de derechos para el modo viral (las sube el dueño a esta carpeta del bucket). */
export const MUSIC_PREFIX = "music/";
