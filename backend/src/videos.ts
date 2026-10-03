import path from "node:path";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { and, count, desc, eq, gt, inArray, or } from "drizzle-orm";
import { z } from "zod";
import {
  checkImportUrl,
  CompleteUploadSchema,
  CreateVideoSchema,
  ImportVideoSchema,
  ProcessVideoSchema,
  UploadPartsRequestSchema,
  planUploadParts,
  resolveVideoMimeType,
  type CreateVideoResponse,
  type ImportVideoResponse,
  type JobParams,
  type ProductConfig,
  type SubtitleStyle,
  type UploadPartUrlsResponse,
  type VideoDownloadResponse,
  type VideoDto,
  type VideoListResponse,
  DOWNLOAD_DISABLED_MESSAGE,
  FEATURES,
} from "@clipflow/shared";
import { createJob, schema, type Database } from "@clipflow/shared/db";
import { deleteVideoRows, purgeVideoFiles } from "./cleanup.js";
import { sendError, sendValidationError } from "./http.js";
import { enqueue, toJobDto, wakeWorkers } from "./jobs.js";
import type { WorkerLauncher } from "./launcher.js";
import type { JobQueue } from "./queue.js";
import type { VideoStorage } from "./storage.js";

const { projects, videos, usage, clips } = schema;
/** Miniaturas en listas: URLs temporales cortas (la web las vuelve a pedir al recargar). */
const THUMB_TTL_SECONDS = 15 * 60;
type VideoRow = typeof videos.$inferSelect;

const IdParams = z.object({ id: z.uuid() });
const ListQuery = z.object({ projectId: z.uuid().optional() });

const EXTENSION_BY_MIME: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
};

/** Solo las subidas iniciadas en las últimas 24 h cuentan para el límite (S3 limpia las viejas). */
const PENDING_WINDOW_MS = 24 * 60 * 60 * 1000;

export function toVideoDto(row: VideoRow, extras: Pick<VideoDto, "thumbnailUrl" | "clipCount"> = {}): VideoDto {
  return {
    ...extras,
    id: row.id,
    projectId: row.projectId,
    status: row.status,
    originalFilename: row.originalFilename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    durationSeconds: row.durationSeconds ?? row.declaredDurationSeconds ?? null,
    rejectionReason: row.rejectionReason,
    createdAt: row.createdAt.toISOString(),
    uploadedAt: row.uploadedAt?.toISOString() ?? null,
    sourceUrl: row.sourceUrl,
  };
}

/** Nombre que se muestra mientras se descarga (el worker lo cambia por el título real). */
function nameFromUrl(url: string): string {
  const u = new URL(url);
  return `${u.hostname.replace(/^www\./, "")}${u.pathname === "/" ? "" : u.pathname}`.slice(0, 120);
}

/** Validez del enlace de descarga del original. */
const DOWNLOAD_TTL_SECONDS = 15 * 60;

/** Nombre del archivo al descargar: el título, sin caracteres raros, con su extensión. */
function downloadName(originalFilename: string, s3Key: string): string {
  const ext = path.extname(s3Key) || ".mp4";
  // Solo letras simples: el nombre viaja en una cabecera HTTP (los acentos se quitan, no se rompen).
  const base = originalFilename
    .replace(/\.[a-z0-9]{2,4}$/i, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w .-]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);
  return `${base || "clipflow-video"}${ext}`;
}

/** Quita caracteres de control del nombre (solo se muestra; nunca se usa como ruta en S3). */
function cleanFilename(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 255);
}

/** Opciones de procesamiento elegidas por el usuario, validadas con la configuración del producto. */
function processingParams(
  product: ProductConfig,
  input: { clipDurationSeconds?: number; subtitleStyle?: SubtitleStyle },
): { ok: true; params: JobParams } | { ok: false; message: string } {
  const duration = input.clipDurationSeconds ?? product.defaultClipDurationSeconds;
  if (!product.clipDurationsSeconds.includes(duration)) {
    return { ok: false, message: `Duraciones permitidas: ${product.clipDurationsSeconds.join(", ")} s.` };
  }
  return { ok: true, params: { clipDurationSeconds: duration, subtitleStyle: input.subtitleStyle ?? "highlight" } };
}

export interface VideoRouteDeps {
  db: Database;
  auth: preHandlerHookHandler;
  storage: VideoStorage;
  queue: JobQueue;
  launcher: WorkerLauncher;
  product: ProductConfig;
  uploadUrlExpiresSeconds: number;
}

/**
 * Subida de videos directo a S3 (multipart):
 * 1. POST /videos               → valida y abre la subida; devuelve cómo partir el archivo.
 * 2. POST /videos/:id/upload-parts → URLs firmadas para subir partes (por lotes).
 * 3. POST /videos/:id/complete  → S3 une las partes; se verifica el tamaño real.
 *    POST /videos/:id/abort     → cancela y borra lo subido.
 * DELETE /videos/:id              → elimina el video con sus clips y todos sus archivos.
 * Todas las consultas filtran por el usuario del token.
 */
export function videoRoutes(deps: VideoRouteDeps) {
  const { db, storage, queue, launcher, product } = deps;
  const notFound = (reply: Parameters<preHandlerHookHandler>[1]) =>
    sendError(reply, 404, "not_found", "Video no encontrado.");

  /** Cantidad de clips listos y miniatura del mejor clip de cada video (una sola consulta). */
  async function clipExtras(videoIds: string[], userId: string) {
    const extras = new Map<string, Pick<VideoDto, "thumbnailUrl" | "clipCount">>();
    if (videoIds.length === 0) return extras;
    const rows = await db
      .select({ videoId: clips.videoId, status: clips.status, score: clips.score, thumb: clips.thumbnailS3Key })
      .from(clips)
      .where(and(eq(clips.userId, userId), inArray(clips.videoId, videoIds)));
    const best = new Map<string, { score: number; thumb: string | null; count: number }>();
    for (const r of rows) {
      if (r.status === "discarded") continue;
      const current = best.get(r.videoId) ?? { score: -1, thumb: null, count: 0 };
      current.count++;
      if ((r.score ?? 0) > current.score && r.thumb) {
        current.score = r.score ?? 0;
        current.thumb = r.thumb;
      }
      best.set(r.videoId, current);
    }
    for (const id of videoIds) {
      const b = best.get(id);
      extras.set(id, {
        clipCount: b?.count ?? 0,
        thumbnailUrl: b?.thumb ? await storage.presignGet(b.thumb, THUMB_TTL_SECONDS) : null,
      });
    }
    return extras;
  }

  async function findOwnVideo(id: string, userId: string) {
    const [row] = await db
      .select()
      .from(videos)
      .where(and(eq(videos.id, id), eq(videos.userId, userId)));
    return row;
  }

  return async (app: FastifyInstance) => {
    app.addHook("preHandler", deps.auth);

    app.get("/videos", async (request, reply) => {
      const query = ListQuery.safeParse(request.query);
      if (!query.success) return sendValidationError(reply, query.error);
      const userId = request.user!.id;
      const rows = await db
        .select()
        .from(videos)
        .where(
          and(
            eq(videos.userId, userId),
            query.data.projectId ? eq(videos.projectId, query.data.projectId) : undefined,
          ),
        )
        .orderBy(desc(videos.createdAt))
        .limit(200);
      const extras = await clipExtras(
        rows.map((r) => r.id),
        userId,
      );
      return { videos: rows.map((r) => toVideoDto(r, extras.get(r.id))) } satisfies VideoListResponse;
    });

    app.get("/videos/:id", async (request, reply) => {
      const params = IdParams.safeParse(request.params);
      if (!params.success) return notFound(reply);
      const row = await findOwnVideo(params.data.id, request.user!.id);
      if (!row) return notFound(reply);
      const extras = await clipExtras([row.id], request.user!.id);
      return toVideoDto(row, extras.get(row.id));
    });

    app.post("/videos", async (request, reply) => {
      const input = CreateVideoSchema.safeParse(request.body);
      if (!input.success) return sendValidationError(reply, input.error);
      const userId = request.user!.id;
      const { projectId, filename, sizeBytes, durationSeconds } = input.data;
      const limits = product.upload;

      const mimeType = resolveVideoMimeType(filename, input.data.mimeType, limits.allowedMimeTypes);
      if (!mimeType) {
        return sendError(reply, 400, "unsupported_type", "Formato no admitido. Usa MP4, MOV, WEBM o MKV.");
      }
      if (sizeBytes > limits.maxBytes) {
        const gb = (limits.maxBytes / 1024 ** 3).toFixed(0);
        return sendError(reply, 400, "file_too_large", `El archivo supera el máximo de ${gb} GB.`);
      }
      if (durationSeconds && durationSeconds > limits.maxDurationSeconds) {
        const hours = (limits.maxDurationSeconds / 3600).toFixed(1).replace(/\.0$/, "");
        return sendError(reply, 400, "video_too_long", `El video supera la duración máxima de ${hours} h.`);
      }

      const [project] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
      if (!project) return sendError(reply, 404, "not_found", "Proyecto no encontrado.");

      const [pending] = await db
        .select({ n: count() })
        .from(videos)
        .where(
          and(
            eq(videos.userId, userId),
            or(eq(videos.status, "pending_upload"), eq(videos.status, "importing")),
            gt(videos.createdAt, new Date(Date.now() - PENDING_WINDOW_MS)),
          ),
        );
      if ((pending?.n ?? 0) >= limits.maxPendingUploads) {
        return sendError(
          reply,
          429,
          "too_many_uploads",
          `Ya tienes ${limits.maxPendingUploads} subidas en curso. Termínalas o cancélalas antes de empezar otra.`,
        );
      }

      // La ruta en S3 la decide el servidor: nunca incluye el nombre que envía el usuario.
      const videoId = crypto.randomUUID();
      const s3Key = `originals/${userId}/${videoId}/original.${EXTENSION_BY_MIME[mimeType]}`;
      const uploadId = await storage.createMultipartUpload(s3Key, mimeType);

      const [row] = await db
        .insert(videos)
        .values({
          id: videoId,
          userId,
          projectId,
          originalFilename: cleanFilename(filename),
          mimeType,
          sizeBytes,
          declaredDurationSeconds: durationSeconds ?? null,
          s3Key,
          s3UploadId: uploadId,
        })
        .returning();

      request.log.info({ videoId, sizeBytes, mimeType }, "subida iniciada");
      // Encender el procesador mientras el video sube: al terminar, empieza sin esperar.
      wakeWorkers(db, launcher, request.log);
      // Respaldo: aviso en la cola (el escalado por métricas también lo enciende).
      queue.warmUp().catch((err: Error) => request.log.warn({ reason: err.name }, "no se pudo enviar el aviso de encendido"));
      return reply.code(201).send({ video: toVideoDto(row!), upload: planUploadParts(sizeBytes) } satisfies CreateVideoResponse);
    });

    // Importar por enlace: lo descarga el worker (nunca la API). El usuario debe confirmar que
    // tiene derechos o permiso para usar el video; se guarda cuándo lo confirmó.
    app.post("/videos/import", async (request, reply) => {
      const input = ImportVideoSchema.safeParse(request.body);
      if (!input.success) return sendValidationError(reply, input.error);
      const checked = checkImportUrl(input.data.url);
      if (!checked.ok) return sendError(reply, 400, "invalid_url", checked.message);
      // "Solo descargar": sin opciones de clips. Si después quiere clips, usa "Crear clips" en el video.
      const downloadOnly = input.data.downloadOnly === true;
      if (downloadOnly && !FEATURES.downloadOnly) return sendError(reply, 403, "download_disabled", DOWNLOAD_DISABLED_MESSAGE);
      const options = downloadOnly ? ({ ok: true, params: { downloadOnly: true } } as const) : processingParams(product, input.data);
      if (!options.ok) return sendError(reply, 400, "invalid_duration", options.message);
      const userId = request.user!.id;

      const [project] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, input.data.projectId), eq(projects.userId, userId)));
      if (!project) return sendError(reply, 404, "not_found", "Proyecto no encontrado.");

      const [pending] = await db
        .select({ n: count() })
        .from(videos)
        .where(
          and(
            eq(videos.userId, userId),
            or(eq(videos.status, "pending_upload"), eq(videos.status, "importing")),
            gt(videos.createdAt, new Date(Date.now() - PENDING_WINDOW_MS)),
          ),
        );
      if ((pending?.n ?? 0) >= product.upload.maxPendingUploads) {
        return sendError(
          reply,
          429,
          "too_many_uploads",
          `Ya tienes ${product.upload.maxPendingUploads} videos subiéndose o descargándose. Espera a que terminen.`,
        );
      }

      const videoId = crypto.randomUUID();
      const [row] = await db
        .insert(videos)
        .values({
          id: videoId,
          userId,
          projectId: project.id,
          status: "importing",
          originalFilename: nameFromUrl(checked.url),
          mimeType: "video/mp4",
          sizeBytes: 0,
          s3Key: `originals/${userId}/${videoId}/original.mp4`,
          sourceUrl: checked.url,
          rightsConfirmedAt: new Date(),
        })
        .returning();
      const { job } = await createJob(db, {
        userId,
        videoId,
        type: "analyze_video",
        // Otra clave para "solo descargar": así después se puede crear clips (analyze:) del mismo video.
        idempotencyKey: `${downloadOnly ? "download" : "analyze"}:${videoId}`,
        params: { ...options.params },
      });
      // Solo el dominio en los registros: el enlace completo puede llevar datos privados.
      request.log.info({ videoId, host: new URL(checked.url).hostname, downloadOnly }, "importación por enlace iniciada");
      await enqueue(queue, job, request.log);
      wakeWorkers(db, launcher, request.log);
      return reply.code(201).send({ video: toVideoDto(row!), job: toJobDto(job) } satisfies ImportVideoResponse);
    });

    app.post("/videos/:id/upload-parts", async (request, reply) => {
      const params = IdParams.safeParse(request.params);
      if (!params.success) return notFound(reply);
      const input = UploadPartsRequestSchema.safeParse(request.body);
      if (!input.success) return sendValidationError(reply, input.error);

      const row = await findOwnVideo(params.data.id, request.user!.id);
      if (!row) return notFound(reply);
      if (row.status !== "pending_upload" || !row.s3UploadId) {
        return sendError(reply, 409, "not_uploading", "Este video no tiene una subida en curso.");
      }
      const { partCount } = planUploadParts(row.sizeBytes);
      if (input.data.partNumbers.some((n) => n > partCount)) {
        return sendError(reply, 400, "validation_error", "Número de parte fuera de rango.");
      }

      const expiresInSeconds = deps.uploadUrlExpiresSeconds;
      const urls = await Promise.all(
        [...new Set(input.data.partNumbers)].map(async (partNumber) => ({
          partNumber,
          url: await storage.presignUploadPart(row.s3Key, row.s3UploadId!, partNumber, expiresInSeconds),
        })),
      );
      return { urls, expiresInSeconds } satisfies UploadPartUrlsResponse;
    });

    app.post("/videos/:id/complete", async (request, reply) => {
      const params = IdParams.safeParse(request.params);
      if (!params.success) return notFound(reply);
      const input = CompleteUploadSchema.safeParse(request.body);
      if (!input.success) return sendValidationError(reply, input.error);

      const userId = request.user!.id;
      const row = await findOwnVideo(params.data.id, userId);
      if (!row) return notFound(reply);
      if (row.status === "uploaded" || row.status === "ready") return toVideoDto(row); // repetir es inofensivo
      if (row.status !== "pending_upload" || !row.s3UploadId) {
        return sendError(reply, 409, "not_uploading", "Este video no tiene una subida en curso.");
      }

      const options = processingParams(product, input.data);
      if (!options.ok) return sendError(reply, 400, "invalid_duration", options.message);

      const { partCount } = planUploadParts(row.sizeBytes);
      const parts = [...input.data.parts].sort((a, b) => a.partNumber - b.partNumber);
      const complete = parts.length === partCount && parts.every((p, i) => p.partNumber === i + 1);
      if (!complete) {
        return sendError(reply, 400, "incomplete_upload", "Faltan partes del archivo. Reintenta la subida.");
      }

      await storage.completeMultipartUpload(row.s3Key, row.s3UploadId, parts);

      // Verificación: el tamaño real en S3 debe ser el declarado.
      const actualSize = await storage.getObjectSize(row.s3Key);
      if (actualSize !== row.sizeBytes) {
        await storage.deleteObject(row.s3Key).catch(() => undefined);
        const [rejected] = await db
          .update(videos)
          .set({ status: "rejected", s3UploadId: null, rejectionReason: "El archivo recibido no coincide con el original." })
          .where(and(eq(videos.id, row.id), eq(videos.userId, userId)))
          .returning();
        request.log.warn({ videoId: row.id, expected: row.sizeBytes, actualSize }, "tamaño no coincide");
        return reply.code(422).send({
          error: { code: "size_mismatch", message: rejected!.rejectionReason },
        });
      }

      const [updated] = await db
        .update(videos)
        .set({ status: "uploaded", s3UploadId: null, uploadedAt: new Date() })
        .where(and(eq(videos.id, row.id), eq(videos.userId, userId)))
        .returning();
      await db.insert(usage).values({
        userId,
        videoId: row.id,
        metric: "storage_bytes",
        quantity: row.sizeBytes,
        details: { event: "upload_completed" },
      });
      request.log.info({ videoId: row.id, sizeBytes: row.sizeBytes }, "subida completada");

      // Procesamiento automático: un trabajo por video (la clave evita duplicados).
      const { job, created } = await createJob(db, {
        userId,
        videoId: row.id,
        type: "analyze_video",
        idempotencyKey: `analyze:${row.id}`,
        params: { ...options.params },
      });
      if (created) {
        await enqueue(queue, job, request.log);
        wakeWorkers(db, launcher, request.log);
      }
      return { ...toVideoDto(updated!), job: toJobDto(job) };
    });

    // Iniciar el procesamiento de un video ya subido que no tiene trabajo
    // (p. ej. videos subidos antes de existir el procesador), eligiendo la duración de los clips.
    // Bajar el video original (p. ej. después de "solo descargar"): URL firmada con su nombre.
    app.get("/videos/:id/download", async (request, reply) => {
      const params = IdParams.safeParse(request.params);
      if (!params.success) return notFound(reply);
      const row = await findOwnVideo(params.data.id, request.user!.id);
      if (!row) return notFound(reply);
      if ((row.status !== "uploaded" && row.status !== "ready") || row.sizeBytes <= 0) {
        return sendError(reply, 409, "not_ready", "El video todavía no está listo para descargar.");
      }
      // Un video importado por enlace no se entrega tal cual mientras «Descargar solo el video» esté
      // desactivado (sí sus clips). Un archivo que subió el propio usuario, sí.
      if (row.sourceUrl && !FEATURES.downloadOnly) return sendError(reply, 403, "download_disabled", DOWNLOAD_DISABLED_MESSAGE);
      // Stream largo: solo se guardó una copia liviana (160p) para elegir los momentos; no se ofrece.
      if ((row.probe as { clipflowAnalysisCopy?: boolean } | null)?.clipflowAnalysisCopy) {
        return sendError(
          reply,
          409,
          "analysis_copy",
          "De este video guardamos solo una copia liviana para elegir los momentos. Para bajarlo completo, impórtalo con «Descargar solo el video».",
        );
      }
      const ttl = DOWNLOAD_TTL_SECONDS;
      return { url: await storage.presignGet(row.s3Key, ttl, downloadName(row.originalFilename, row.s3Key)), expiresInSeconds: ttl } satisfies VideoDownloadResponse;
    });

    app.post("/videos/:id/process", async (request, reply) => {
      const params = IdParams.safeParse(request.params);
      if (!params.success) return notFound(reply);
      const input = ProcessVideoSchema.safeParse(request.body ?? {});
      if (!input.success) return sendValidationError(reply, input.error);
      const userId = request.user!.id;
      const row = await findOwnVideo(params.data.id, userId);
      if (!row) return notFound(reply);
      if (row.status !== "uploaded" && row.status !== "ready") {
        return sendError(reply, 409, "not_processable", "Este video no se puede procesar.");
      }
      const options = processingParams(product, input.data);
      if (!options.ok) return sendError(reply, 400, "invalid_duration", options.message);
      const { job, created } = await createJob(db, {
        userId,
        videoId: row.id,
        type: "analyze_video",
        idempotencyKey: `analyze:${row.id}`,
        params: { ...options.params },
      });
      if (!created) return sendError(reply, 409, "already_processing", "Este video ya tiene un procesamiento. Usa Reintentar si falló.");
      await enqueue(queue, job, request.log);
      wakeWorkers(db, launcher, request.log);
      return reply.code(201).send(toJobDto(job));
    });

    app.delete("/videos/:id", async (request, reply) => {
      const params = IdParams.safeParse(request.params);
      if (!params.success) return notFound(reply);
      const removed = await deleteVideoRows(db, request.user!.id, { videoId: params.data.id });
      if (removed.status === "not_found") return notFound(reply);
      if (removed.status === "busy") {
        return sendError(reply, 409, "video_processing", "Este video se está procesando. Cancélalo o espera a que termine para eliminarlo.");
      }
      await purgeVideoFiles(storage, removed.files, request.log);
      request.log.info({ videoId: params.data.id }, "video eliminado");
      return reply.code(204).send();
    });

    app.post("/videos/:id/abort", async (request, reply) => {
      const params = IdParams.safeParse(request.params);
      if (!params.success) return notFound(reply);
      const userId = request.user!.id;
      const row = await findOwnVideo(params.data.id, userId);
      if (!row) return notFound(reply);
      if (row.status !== "pending_upload") {
        return sendError(reply, 409, "not_uploading", "Este video no tiene una subida en curso.");
      }
      if (row.s3UploadId) {
        await storage.abortMultipartUpload(row.s3Key, row.s3UploadId).catch((err: Error) => {
          request.log.warn({ videoId: row.id, reason: err.name }, "no se pudo abortar en S3 (se limpiará sola)");
        });
      }
      await db.delete(videos).where(and(eq(videos.id, row.id), eq(videos.userId, userId)));
      return reply.code(204).send();
    });
  };
}
