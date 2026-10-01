import { z } from "zod";

/** Validaciones compartidas: el frontend las usa para avisar antes, la API para rechazar. */
export const ProjectInputSchema = z.object({
  name: z.string().trim().min(1, "El nombre es obligatorio").max(120, "Máximo 120 caracteres"),
  description: z.string().trim().max(1000, "Máximo 1000 caracteres").nullish(),
});

export const ProjectUpdateSchema = ProjectInputSchema.partial().refine(
  (value) => value.name !== undefined || value.description !== undefined,
  { message: "No hay cambios" },
);

export type ProjectInput = z.infer<typeof ProjectInputSchema>;
export type ProjectUpdate = z.infer<typeof ProjectUpdateSchema>;

/** Datos que el navegador envía antes de subir un video. */
export const CreateVideoSchema = z.object({
  projectId: z.uuid("Proyecto inválido"),
  filename: z.string().trim().min(1, "Falta el nombre del archivo").max(255, "Nombre de archivo demasiado largo"),
  sizeBytes: z.number().int().positive("El archivo está vacío"),
  mimeType: z.string().max(100),
  /** Duración leída por el navegador (puede no estar disponible). */
  durationSeconds: z.number().positive().max(24 * 60 * 60).nullish(),
});

export const UploadPartsRequestSchema = z.object({
  partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(100),
});

/** Estilo de los subtítulos quemados en el video. */
export const SUBTITLE_STYLES = ["highlight", "classic", "none"] as const;
export const SubtitleStyleSchema = z.enum(SUBTITLE_STYLES);

/** Opciones que el usuario elige antes de procesar. */
const ProcessingOptions = {
  clipDurationSeconds: z.number().int().positive().optional(),
  subtitleStyle: SubtitleStyleSchema.optional(),
};

export const CompleteUploadSchema = z.object({
  parts: z
    .array(z.object({ partNumber: z.number().int().min(1).max(10_000), etag: z.string().min(1).max(200) }))
    .min(1)
    .max(10_000),
  ...ProcessingOptions,
});

export type CreateVideoInput = z.infer<typeof CreateVideoSchema>;

/** Extensión → tipo MIME de los formatos aceptados. */
export const VIDEO_EXTENSIONS: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
};

/**
 * Tipo MIME confiable a partir del nombre y el tipo que reporta el navegador.
 * Devuelve null si el archivo no es de un formato aceptado. El worker comprueba después
 * el contenido real con ffprobe: esto es solo el primer filtro.
 */
export function resolveVideoMimeType(filename: string, reportedMime: string, allowed: string[]): string | null {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  const fromExt = VIDEO_EXTENSIONS[ext];
  if (!fromExt || !allowed.includes(fromExt)) return null;
  // El navegador a veces no informa el tipo (p. ej. .mkv): se usa el de la extensión.
  if (reportedMime === "" || reportedMime === "application/octet-stream") return fromExt;
  return reportedMime === fromExt || (fromExt === "video/mp4" && reportedMime === "video/x-m4v") ? fromExt : null;
}

const MiB = 1024 * 1024;

/** Tamaño de cada parte para la subida multipart a S3 (mín. 16 MiB, máx. 10.000 partes). */
export function planUploadParts(sizeBytes: number): { partSizeBytes: number; partCount: number } {
  const minPart = 16 * MiB;
  const partSizeBytes = Math.max(minPart, Math.ceil(sizeBytes / 10_000 / MiB) * MiB);
  return { partSizeBytes, partCount: Math.max(1, Math.ceil(sizeBytes / partSizeBytes)) };
}

export const ProcessVideoSchema = z.object(ProcessingOptions);

/** Importar un video desde un enlace (lo descarga el worker). */
export const ImportVideoSchema = z.object({
  projectId: z.uuid("Proyecto inválido"),
  url: z.string().trim().min(1, "Pega el enlace del video").max(2048, "El enlace es demasiado largo"),
  /** El usuario confirma que el video es suyo o que tiene permiso de quien tenga los derechos. */
  rightsConfirmed: z.literal(true, "Debes confirmar que tienes derechos o permiso para usar el video"),
  ...ProcessingOptions,
});

/**
 * Revisa un enlace antes de aceptarlo: solo http(s), sin usuario/contraseña y sin direcciones
 * internas escritas a mano (el worker vuelve a comprobar la IP real al descargar).
 * Devuelve el enlace normalizado o un mensaje de error.
 */
export function checkImportUrl(raw: string): { ok: true; url: string } | { ok: false; message: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, message: "Ese enlace no es válido. Cópialo completo, empezando por https://" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, message: "Solo se aceptan enlaces que empiecen con https:// o http://" };
  }
  if (url.username || url.password) return { ok: false, message: "El enlace no puede incluir usuario ni contraseña." };
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || isPrivateAddress(host)) {
    return { ok: false, message: "Ese enlace apunta a una dirección privada." };
  }
  if (!host.includes(".") && !host.includes(":")) return { ok: false, message: "Ese enlace no es válido." };
  url.hash = "";
  return { ok: true, url: url.toString() };
}

/** true si es una IP (v4 o v6) privada, local, reservada o de metadatos de la nube. */
export function isPrivateAddress(address: string): boolean {
  const a = address.toLowerCase();
  // IPv4 dentro de IPv6 (::ffff:127.0.0.1, o como la normaliza el navegador: ::ffff:7f00:1).
  let v4 = a.startsWith("::ffff:") ? a.slice(7) : a;
  const hex = v4.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (a.startsWith("::ffff:") && hex) {
    const hi = parseInt(hex[1]!, 16);
    const lo = parseInt(hex[2]!, 16);
    v4 = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  const m = v4.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [o1, o2] = [Number(m[1]), Number(m[2])];
    return (
      o1 === 0 ||
      o1 === 10 ||
      o1 === 127 ||
      (o1 === 100 && o2 >= 64 && o2 <= 127) || // CGNAT
      (o1 === 169 && o2 === 254) || // enlace local y metadatos (169.254.169.254, 169.254.170.2)
      (o1 === 172 && o2 >= 16 && o2 <= 31) ||
      (o1 === 192 && o2 === 168) ||
      (o1 === 192 && o2 === 0) ||
      (o1 === 198 && (o2 === 18 || o2 === 19)) ||
      o1 >= 224 // multicast y reservadas
    );
  }
  if (a.includes(":")) {
    return (
      a === "::" ||
      a === "::1" ||
      a.startsWith("fc") ||
      a.startsWith("fd") || // privadas (ULA), incluye fd00:ec2::254 de AWS
      a.startsWith("fe8") ||
      a.startsWith("fe9") ||
      a.startsWith("fea") ||
      a.startsWith("feb") || // enlace local
      a.startsWith("ff") // multicast
    );
  }
  return false;
}

export const ClipUpdateSchema = z.object({
  status: z.enum(["generated", "approved", "discarded"]).optional(),
  title: z.string().trim().max(120).nullish(),
});
