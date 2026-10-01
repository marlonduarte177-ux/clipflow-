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

export const ClipUpdateSchema = z.object({
  status: z.enum(["generated", "approved", "discarded"]).optional(),
  title: z.string().trim().max(120).nullish(),
});
