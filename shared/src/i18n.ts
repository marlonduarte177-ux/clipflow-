/**
 * Idiomas de la app y traducción al inglés de los mensajes que genera el servidor (API y
 * procesador). El servidor siempre responde en español; la web los traduce con
 * `translateMessage` cuando el usuario eligió inglés. Si un mensaje no está aquí, se muestra tal cual.
 */
export const LOCALES = ["es", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "es";

export function isLocale(value: unknown): value is Locale {
  return value === "es" || value === "en";
}

/** Pasos del procesamiento que aparecen dentro de otros mensajes ("Ocurrió un error temporal al …"). */
const STEPS: Record<string, string> = {
  "analizar el video": "analyze the video",
  "descargar el enlace": "download the link",
  "elegir los momentos": "pick the moments",
  "generar y guardar los clips": "create and save the clips",
  "guardar el resultado": "save the result",
  "guardar el video importado": "save the imported video",
  "guardar el video": "save the video",
  "leer el video original": "read the original video",
  "preparar el trabajo": "prepare the job",
  "preparar el video para el celular": "prepare the video for phones",
  "registrar el video importado": "register the imported video",
  "revisar el video": "check the video",
  // Pasos de la IA ("falló la transcripción: …").
  "la transcripción": "transcription",
  "el análisis de momentos": "moment analysis",
  "la preparación del audio": "audio preparation",
};

/** Motivos de fallo del proxy de descargas. */
const PROXY_REASONS: Record<string, string> = {
  "usuario o contraseña incorrectos, 407": "wrong username or password, 407",
  "sin saldo, 402": "no balance, 402",
  "el proveedor no permite este sitio, 403": "the provider does not allow this site, 403",
  "no se encontró el servidor del proxy": "proxy server not found",
  "tiempo de espera agotado": "timed out",
  "no se pudo conectar": "could not connect",
};

const EXACT: Record<string, string> = {
  // API
  "Datos inválidos.": "Invalid data.",
  "De este video guardamos solo una copia liviana para elegir los momentos. Para bajarlo completo, impórtalo con «Descargar solo el video».":
    "For this video we only kept a light copy to pick the moments. To get the full video, import it with “Download video only”.",
  "El cuerpo no es JSON válido.": "The request body is not valid JSON.",
  "El video todavía no está listo para descargar.": "The video is not ready to download yet.",
  "Envía los datos como JSON.": "Send the data as JSON.",
  "Esta cuenta está desactivada.": "This account is disabled.",
  "Este trabajo ya terminó.": "This job has already finished.",
  "Este video no se puede procesar.": "This video cannot be processed.",
  "Este video no tiene una subida en curso.": "This video has no upload in progress.",
  "Este video se está procesando. Cancélalo o espera a que termine para eliminarlo.":
    "This video is being processed. Cancel it or wait for it to finish before deleting it.",
  "Este video ya tiene un procesamiento. Usa Reintentar si falló.": "This video already has a processing job. Use Retry if it failed.",
  "Faltan partes del archivo. Reintenta la subida.": "Parts of the file are missing. Try the upload again.",
  "Formato no admitido. Usa MP4, MOV, WEBM o MKV.": "Unsupported format. Use MP4, MOV, WEBM or MKV.",
  "Hay un video procesándose. Espera a que termine (o cancélalo) y vuelve a intentarlo.":
    "A video is being processed. Wait for it to finish (or cancel it) and try again.",
  "Inicia sesión para continuar.": "Sign in to continue.",
  "No se pudo enviar a procesar. Inténtalo en unos minutos.": "We couldn't send it for processing. Try again in a few minutes.",
  "Número de parte fuera de rango.": "Part number out of range.",
  "Ocurrió un error inesperado. Intenta de nuevo.": "Something went wrong. Please try again.",
  "Parámetros inválidos.": "Invalid parameters.",
  "Proyecto no encontrado.": "Project not found.",
  "Ruta no encontrada.": "Route not found.",
  "Solo se pueden reintentar trabajos fallidos, cancelados o que terminaron sin análisis de IA.":
    "Only failed or cancelled jobs, or jobs that finished without AI analysis, can be retried.",
  "Trabajo no encontrado.": "Job not found.",
  "Tu sesión no es válida o expiró.": "Your session is invalid or has expired.",
  "Un video de este proyecto se está procesando. Cancélalo o espera a que termine.":
    "A video in this project is being processed. Cancel it or wait for it to finish.",
  "Video no encontrado.": "Video not found.",
  "Clip no encontrado.": "Clip not found.",
  // Web (errores propios del navegador)
  "La API todavía no está configurada (NEXT_PUBLIC_API_URL).": "The API is not configured yet (NEXT_PUBLIC_API_URL).",
  "Tu sesión expiró. Vuelve a iniciar sesión.": "Your session expired. Sign in again.",
  "No se pudo conectar con el servidor. Revisa tu internet.": "Could not connect to the server. Check your internet.",
  "No se pudo preparar el video para compartir.": "The video could not be prepared for sharing.",
  "Error de red": "Network error",
  "Por ahora ClipFlow no ofrece descargar videos de otras plataformas. Puedes crear clips con el enlace.":
    "For now ClipFlow does not offer downloading videos from other platforms. You can create clips from the link.",
  "El archivo recibido no coincide con el original.": "The received file does not match the original.",
  // Validación (shared)
  "Debes confirmar que tienes derechos o permiso para usar el video": "You must confirm that you own the video or have permission to use it",
  "El archivo está vacío": "The file is empty",
  "El enlace es demasiado largo": "The link is too long",
  "El enlace no puede incluir usuario ni contraseña.": "The link cannot include a username or password.",
  "El nombre es obligatorio": "The name is required",
  "Ese enlace apunta a una dirección privada.": "That link points to a private address.",
  "Ese enlace no es válido. Cópialo completo, empezando por https://": "That link is not valid. Copy the whole link, starting with https://",
  "Ese enlace no es válido.": "That link is not valid.",
  "Falta el nombre del archivo": "The file name is missing",
  "Máximo 1000 caracteres": "Maximum 1000 characters",
  "Máximo 120 caracteres": "Maximum 120 characters",
  "Nombre de archivo demasiado largo": "File name is too long",
  "Pega el enlace del video": "Paste the video link",
  "Proyecto inválido": "Invalid project",
  "Solo se aceptan enlaces que empiecen con https:// o http://": "Only links starting with https:// or http:// are accepted",
  "No hay cambios": "No changes",
  // Procesador: descargas
  "El archivo no contiene un video válido": "The file does not contain a valid video",
  "El archivo no es un video válido o está dañado.": "The file is not a valid video or is damaged.",
  "El enlace no devolvió ningún video.": "The link did not return any video.",
  "El enlace no es un archivo de video. Si es de una red social, usa el enlace de la publicación; si es de otra página, sube el video como archivo.":
    "The link is not a video file. If it is from a social network, use the post link; if it is from another site, upload the video as a file.",
  "El video supera el tamaño máximo permitido.": "The video exceeds the maximum allowed size.",
  "El video supera la duración máxima permitida o es una transmisión en vivo.":
    "The video exceeds the maximum allowed length or is a live stream.",
  "El video supera la duración máxima permitida.": "The video exceeds the maximum allowed length.",
  "El video ya no existe.": "The video no longer exists.",
  "Ese enlace es de un canal, no de un video. Pega el enlace de un clip o de un video guardado.":
    "That link is for a channel, not a video. Paste the link of a clip or a saved video.",
  "Este video es privado o pide iniciar sesión, así que no se puede descargar.":
    "This video is private or requires signing in, so it cannot be downloaded.",
  "Este video es solo para suscriptores del canal, así que no se puede importar.":
    "This video is for channel subscribers only, so it cannot be imported.",
  "Este video no está disponible desde el país de nuestros servidores. Descárgalo y súbelo como archivo.":
    "This video is not available from our servers' country. Download it and upload it as a file.",
  "Este video tiene restricción de edad y la plataforma pide iniciar sesión para verlo. Descárgalo y súbelo como archivo.":
    "This video is age-restricted and the platform requires signing in to watch it. Download it and upload it as a file.",
  "Falta el enlace del video para cortar los clips.": "The video link needed to cut the clips is missing.",
  "Falta el enlace del video.": "The video link is missing.",
  "La descarga se cortó. Lo intentaremos de nuevo.": "The download was interrupted. We'll try again.",
  "La plataforma bloqueó la descarga desde nuestros servidores. Descarga el video y súbelo como archivo.":
    "The platform blocked the download from our servers. Download the video and upload it as a file.",
  "La plataforma no permitió descargar este video desde nuestros servidores. Descárgalo y súbelo como archivo.":
    "The platform did not allow downloading this video from our servers. Download it and upload it as a file.",
  "La plataforma no respondió. Lo intentaremos de nuevo.": "The platform did not respond. We'll try again.",
  "No encontramos un video en ese enlace (puede que se haya borrado).": "We couldn't find a video at that link (it may have been deleted).",
  "No encontramos un video en ese enlace.": "We couldn't find a video at that link.",
  "No pudimos bajar un tramo del video. Lo intentaremos de nuevo.": "We couldn't download part of the video. We'll try again.",
  "No pudimos descargar el video de ese enlace. Lo intentaremos de nuevo.": "We couldn't download the video from that link. We'll try again.",
  "No pudimos descargar el video de ese enlace.": "We couldn't download the video from that link.",
  "No pudimos leer los datos de ese enlace.": "We couldn't read the details of that link.",
  "No pudimos procesar este video. Lo intentaremos de nuevo.": "We couldn't process this video. We'll try again.",
  "No pudimos unir el video y el audio de ese enlace. Lo intentaremos de nuevo.":
    "We couldn't merge the video and audio from that link. We'll try again.",
  "Ocurrió un error temporal al procesar el video.": "A temporary error occurred while processing the video.",
  "Cancelado por el usuario": "Cancelled by the user",
  "No se pueden importar transmisiones en vivo.": "Live streams can't be imported.",
  "El enlace redirige a un lugar no permitido.": "The link redirects to a place that is not allowed.",
  "El enlace redirige demasiadas veces.": "The link redirects too many times.",
  "El servidor del enlace no respondió.": "The link's server did not respond.",
  "No se pudo conectar con el enlace.": "Could not connect to the link.",
  // Procesador: IA
  "El video no tiene audio": "The video has no audio",
  "Falta la clave de OpenAI en Secrets Manager": "The OpenAI key is missing in Secrets Manager",
  "IA desactivada por configuración": "AI disabled in the settings",
  "IA no configurada": "AI not configured",
  "La clave de OpenAI no es válida": "The OpenAI key is not valid",
  "La respuesta de OpenAI se cortó por larga": "The OpenAI response was cut off for being too long",
  "No se detectó habla (p. ej. gameplay o música); los clips se eligieron por acción, sonido y movimiento":
    "No speech was detected (e.g. gameplay or music); the clips were picked by action, sound and motion",
  "No se pudo conectar con OpenAI": "Could not connect to OpenAI",
  "OpenAI devolvió JSON inválido": "OpenAI returned invalid JSON",
  "OpenAI limitó las solicitudes por minuto de tu cuenta (límite de velocidad)": "OpenAI limited your account's requests per minute (rate limit)",
  "Respuesta inesperada de OpenAI": "Unexpected response from OpenAI",
  "Tu cuenta de OpenAI no tiene saldo o llegó a su límite de gasto (revisa Billing y Limits en platform.openai.com)":
    "Your OpenAI account has no balance or reached its spending limit (check Billing and Limits at platform.openai.com)",
  "Análisis con formato inesperado": "Analysis with an unexpected format",
  "Análisis de imágenes con formato inesperado": "Image analysis with an unexpected format",
  "Transcripción con formato inesperado": "Transcript with an unexpected format",
  "Solo descarga": "Download only",
  "Falta la clave de AssemblyAI en Secrets Manager": "The AssemblyAI key is missing in Secrets Manager",
  "La clave de AssemblyAI no es válida": "The AssemblyAI key is not valid",
  "Tu cuenta de AssemblyAI no tiene saldo (revisa Billing en assemblyai.com)": "Your AssemblyAI account has no balance (check Billing at assemblyai.com)",
  "AssemblyAI está saturado por ahora": "AssemblyAI is saturated right now",
  "AssemblyAI no pudo transcribir el audio": "AssemblyAI could not transcribe the audio",
  "AssemblyAI tardó demasiado en transcribir": "AssemblyAI took too long to transcribe",
  "No se pudo conectar con AssemblyAI": "Could not connect to AssemblyAI",
  "Respuesta inesperada de AssemblyAI": "Unexpected response from AssemblyAI",
  "OpenAI está saturado por ahora (límite de uso por minuto de tu cuenta). Lo reintentamos en unos minutos; la transcripción ya quedó guardada.":
    "OpenAI is saturated right now (your account's per-minute limit). We'll retry in a few minutes; the transcript is already saved.",
  "Tu cuenta de OpenAI llegó a su límite de uso por día (se recupera en unas horas; puedes subir de nivel en platform.openai.com → Limits)":
    "Your OpenAI account reached its daily usage limit (it recovers in a few hours; you can move up a tier at platform.openai.com → Limits)",
  "El pedido a OpenAI es más grande que el límite por minuto de tu cuenta (sube de nivel en platform.openai.com → Limits)":
    "The request to OpenAI is larger than your account's per-minute limit (move up a tier at platform.openai.com → Limits)",
  "error inesperado": "unexpected error",
};

type Rule = [RegExp, (m: RegExpExecArray, t: (s: string) => string) => string];

const RULES: Rule[] = [
  [/^Ocurrió un error temporal al (.+?)( \(([^)]+)\))?\. Lo intentaremos de nuevo\.$/, (m) => `A temporary error occurred while trying to ${STEPS[m[1]!] ?? m[1]}${m[3] ? ` (${m[3]})` : ""}. We'll try again.`],
  [/^Ocurrió un error temporal al (.+?)( \(([^)]+)\))?\. Lo intentaremos de nuevo$/, (m) => `A temporary error occurred while trying to ${STEPS[m[1]!] ?? m[1]}${m[3] ? ` (${m[3]})` : ""}. We'll try again`],
  [/^No pudimos abrir el video original para cortar los clips: (.+)$/s, (m, t) => `We couldn't open the original video to cut the clips: ${t(m[1]!)}`],
  [/^No se pudo bajar un tramo del video \((.+)\)\.$/s, (m, t) => `Part of the video could not be downloaded (${t(m[1]!)}).`],
  [/^No se pudo iniciar la descarga \((.+)\)\.$/s, (m) => `The download could not be started (${m[1]}).`],
  [/^Nuestro servicio de descarga no respondió \(proxy: (.+)\)\. Lo intentaremos de nuevo\.$/, (m) => `Our download service did not respond (proxy: ${PROXY_REASONS[m[1]!] ?? m[1]}). We'll try again.`],
  [/^S3 respondió (\d+)( sin ETag)?$/, (m) => `S3 responded ${m[1]}${m[2] ? " without ETag" : ""}`],
  [/^El enlace respondió con un error \((\d+)\)\.$/, (m) => `The link returned an error (${m[1]}).`],
  [/^falló (.+?): (.+)$/s, (m, t) => `${STEPS[m[1]!] ?? m[1]} failed: ${t(m[2]!)}`],
  [/^incompleto: se analizaron (\d+) de (\d+) grupos de imágenes \(límite de tiempo\)$/, (m) => `incomplete: ${m[1]} of ${m[2]} image groups were analyzed (time limit)`],
  [/^OpenAI rechazó la solicitud \((.+)\)$/, (m) => `OpenAI rejected the request (${m[1]})`],
  [/^OpenAI tuvo un error temporal \((.+)\)$/, (m) => `OpenAI had a temporary error (${m[1]})`],
  [/^OpenAI respondió (.+)$/, (m) => `OpenAI responded ${m[1]}`],
  [/^AssemblyAI tuvo un error temporal \((.+)\)$/, (m) => `AssemblyAI had a temporary error (${m[1]})`],
  [/^AssemblyAI rechazó la solicitud \((.+)\)$/, (m) => `AssemblyAI rejected the request (${m[1]})`],
  [/^El archivo supera el máximo de (.+) GB\.$/, (m) => `The file exceeds the maximum of ${m[1]} GB.`],
  [/^El video supera la duración máxima de (.+) h\.$/, (m) => `The video exceeds the maximum length of ${m[1]} h.`],
  [/^Ya tienes (\d+) subidas en curso\. Termínalas o cancélalas antes de empezar otra\.$/, (m) => `You already have ${m[1]} uploads in progress. Finish or cancel them before starting another one.`],
  [/^Ya tienes (\d+) videos subiéndose o descargándose\. Espera a que terminen\.$/, (m) => `You already have ${m[1]} videos uploading or downloading. Wait for them to finish.`],
  [/^(.+) no encontrado\.$/, (m) => `${m[1] === "Video" ? "Video" : m[1] === "Proyecto" ? "Project" : m[1] === "Trabajo" ? "Job" : m[1] === "Clip" ? "Clip" : m[1]} not found.`],
  [/^Por ahora no se pueden importar videos de (.+?)\. Descárgalo y súbelo como archivo\. Por enlace funcionan (.+) y (.+)\.$/, (m) => `For now videos from ${m[1]} can't be imported. Download it and upload it as a file. Links work for ${m[2]} and ${m[3]}.`],
];

function translateEn(message: string): string {
  const exact = EXACT[message];
  if (exact !== undefined) return exact;
  for (const [re, fn] of RULES) {
    const m = re.exec(message);
    if (m) return fn(m, translateEn);
  }
  return message;
}

/** Traduce un mensaje del servidor al idioma elegido (en español se devuelve igual). */
export function translateMessage(message: string, locale: Locale): string;
export function translateMessage(message: string | null | undefined, locale: Locale): string | null | undefined;
export function translateMessage(message: string | null | undefined, locale: Locale): string | null | undefined {
  if (!message || locale === "es") return message;
  return translateEn(message);
}
