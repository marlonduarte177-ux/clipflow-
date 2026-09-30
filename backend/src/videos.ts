import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { and, count, desc, eq, gt } from "drizzle-orm";
import { z } from "zod";
import {
  CompleteUploadSchema,
  CreateVideoSchema,
  ProcessVideoSchema,
  UploadPartsRequestSchema,
  planUploadParts,
  resolveVideoMimeType,
  type CreateVideoResponse,
  type ProductConfig,
  type UploadPartUrlsResponse,
  type VideoDto,
  type VideoListResponse,
} from "@clipflow/shared";
import { createJob, schema, type Database } from "@clipflow/shared/db";
import { sendError, sendValidationError } from "./http.js";
import { enqueue, toJobDto, wakeWorkers } from "./jobs.js";
import type { WorkerLauncher } from "./launcher.js";
import type { JobQueue } from "./queue.js";
import type { VideoStorage } from "./storage.js";

const { projects, videos, usage } = schema;
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

export function toVideoDto(row: VideoRow): VideoDto {
  return {
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
  };
}

/** Quita caracteres de control del nombre (solo se muestra; nunca se usa como ruta en S3). */
function cleanFilename(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 255);
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
 * Todas las consultas filtran por el usuario del token.
 */
export function videoRoutes(deps: VideoRouteDeps) {
  const { db, storage, queue, launcher, product } = deps;
  const notFound = (reply: Parameters<preHandlerHookHandler>[1]) =>
    sendError(reply, 404, "not_found", "Video no encontrado.");

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
      return { videos: rows.map(toVideoDto) } satisfies VideoListResponse;
    });

    app.get("/videos/:id", async (request, reply) => {
      const params = IdParams.safeParse(request.params);
      if (!params.success) return notFound(reply);
      const row = await findOwnVideo(params.data.id, request.user!.id);
      return row ? toVideoDto(row) : notFound(reply);
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
            eq(videos.status, "pending_upload"),
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
        params: { clipDurationSeconds: product.defaultClipDurationSeconds },
      });
      if (created) {
        await enqueue(queue, job, request.log);
        wakeWorkers(db, launcher, request.log);
      }
      return { ...toVideoDto(updated!), job: toJobDto(job) };
    });

    // Iniciar el procesamiento de un video ya subido que no tiene trabajo
    // (p. ej. videos subidos antes de existir el procesador), eligiendo la duración de los clips.
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
      const duration = input.data.clipDurationSeconds ?? product.defaultClipDurationSeconds;
      if (!product.clipDurationsSeconds.includes(duration)) {
        return sendError(reply, 400, "invalid_duration", `Duraciones permitidas: ${product.clipDurationsSeconds.join(", ")} s.`);
      }
      const { job, created } = await createJob(db, {
        userId,
        videoId: row.id,
        type: "analyze_video",
        idempotencyKey: `analyze:${row.id}`,
        params: { clipDurationSeconds: duration },
      });
      if (!created) return sendError(reply, 409, "already_processing", "Este video ya tiene un procesamiento. Usa Reintentar si falló.");
      await enqueue(queue, job, request.log);
      wakeWorkers(db, launcher, request.log);
      return reply.code(201).send(toJobDto(job));
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
