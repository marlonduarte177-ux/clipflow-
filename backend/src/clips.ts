import type { FastifyInstance, FastifyReply, preHandlerHookHandler } from "fastify";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { ClipUpdateSchema, fullTranscriptKey, type ClipDto, type ClipEditOptions, type ClipListResponse, type JobResult } from "@clipflow/shared";
import { createJob, schema, type Database } from "@clipflow/shared/db";
import { BILLING_OFF, canEditClips, type BillingSettings } from "./billing.js";
import { sendError, sendValidationError } from "./http.js";
import { enqueue, toJobDto, wakeWorkers } from "./jobs.js";
import type { WorkerLauncher } from "./launcher.js";
import type { JobQueue } from "./queue.js";
import type { VideoStorage } from "./storage.js";

const { clips, subtitles, videos, processingJobs } = schema;
type VideoRow = typeof videos.$inferSelect;

/** Editar clips (modo viral): cuáles y cómo. */
const EditBody = z.object({
  clipIds: z.array(z.uuid()).min(1).max(50),
  mode: z.literal("viral"),
  music: z.boolean().default(true),
});

/**
 * ¿Se puede editar? Con su copia limpia, o (clips anteriores al editor) si el video original sigue
 * guardado: archivos subidos, no enlaces (su original se borra al terminar los clips).
 */
function canEditClip(row: ClipRow, video: Pick<VideoRow, "sourceUrl" | "probe"> | undefined): boolean {
  if (row.cleanS3Key) return true;
  const probe = video?.probe as { clipflowOriginalDeleted?: boolean; clipflowAnalysisCopy?: boolean } | null | undefined;
  return Boolean(video && !video.sourceUrl && !probe?.clipflowOriginalDeleted && !probe?.clipflowAnalysisCopy);
}
type ClipRow = typeof clips.$inferSelect;
const IdParams = z.object({ id: z.uuid() });

/** Las URLs de preview caducan pronto: la web las vuelve a pedir si hace falta. */
const URL_TTL_SECONDS = 15 * 60;

export function clipRoutes(deps: {
  db: Database;
  auth: preHandlerHookHandler;
  storage: VideoStorage;
  billing?: BillingSettings;
  queue?: JobQueue;
  launcher?: WorkerLauncher;
}) {
  const { db, storage } = deps;
  const billing = deps.billing ?? BILLING_OFF;
  const notFound = (reply: FastifyReply, what = "Clip") => sendError(reply, 404, "not_found", `${what} no encontrado.`);

  /** Subtítulos de varios clips en una sola consulta. */
  async function subtitlesFor(clipIds: string[], userId: string) {
    if (clipIds.length === 0) return new Map<string, { srt?: string; vtt?: string }>();
    const rows = await db
      .select()
      .from(subtitles)
      .where(and(inArray(subtitles.clipId, clipIds), eq(subtitles.userId, userId)));
    const map = new Map<string, { srt?: string; vtt?: string }>();
    for (const r of rows) {
      if (!r.clipId || r.format === "json") continue;
      map.set(r.clipId, { ...map.get(r.clipId), [r.format]: r.s3Key });
    }
    return map;
  }

  /** Transcripción completa del último procesamiento terminado con IA (si el archivo existe). */
  async function transcriptFor(videoId: string, userId: string): Promise<ClipListResponse["transcript"]> {
    const [job] = await db
      .select({ id: processingJobs.id, result: processingJobs.result })
      .from(processingJobs)
      .where(and(eq(processingJobs.videoId, videoId), eq(processingJobs.userId, userId), eq(processingJobs.status, "completed")))
      .orderBy(desc(processingJobs.createdAt))
      .limit(1);
    const result = job?.result as JobResult | null | undefined;
    if (!job || result?.ai !== "used") return null;
    const key = fullTranscriptKey(userId, job.id);
    // Videos procesados antes de que existiera no la tienen.
    if ((await storage.getObjectSize(key)) === null) return null;
    return { vttUrl: await storage.presignGet(key, URL_TTL_SECONDS), language: result.language ?? null };
  }

  /** `editor`: el usuario puede usar el editor (y entonces el video, para saber si se puede editar). */
  async function toDto(
    row: ClipRow,
    subs?: { srt?: string; vtt?: string },
    editor?: { video: Pick<VideoRow, "sourceUrl" | "probe"> | undefined },
  ): Promise<ClipDto> {
    return {
      id: row.id,
      videoId: row.videoId,
      status: row.status,
      title: row.title,
      startSeconds: row.startSeconds,
      endSeconds: row.endSeconds,
      aspectRatio: row.aspectRatio,
      score: row.score,
      scoreBreakdown: row.scoreBreakdown as Record<string, number> | null,
      videoUrl: row.s3Key ? await storage.presignGet(row.s3Key, URL_TTL_SECONDS) : null,
      thumbnailUrl: row.thumbnailS3Key ? await storage.presignGet(row.thumbnailS3Key, URL_TTL_SECONDS) : null,
      subtitlesVttUrl: subs?.vtt ? await storage.presignGet(subs.vtt, URL_TTL_SECONDS) : null,
      subtitlesSrtUrl: subs?.srt
        ? await storage.presignGet(subs.srt, URL_TTL_SECONDS, `clipflow-${Math.round(row.startSeconds)}s.srt`)
        : null,
      ...(editor
        ? {
            editable: canEditClip(row, editor.video),
            editedVideoUrl: row.editedS3Key ? await storage.presignGet(row.editedS3Key, URL_TTL_SECONDS) : null,
            edit: (row.edit as ClipDto["edit"]) ?? null,
          }
        : {}),
      createdAt: row.createdAt.toISOString(),
    };
  }

  return async (app: FastifyInstance) => {
    app.addHook("preHandler", deps.auth);

    app.get("/videos/:id/clips", async (request, reply) => {
      const params = IdParams.safeParse(request.params);
      if (!params.success) return notFound(reply, "Video");
      const userId = request.user!.id;
      const [video] = await db
        .select({ id: videos.id, sourceUrl: videos.sourceUrl, probe: videos.probe })
        .from(videos)
        .where(and(eq(videos.id, params.data.id), eq(videos.userId, userId)));
      if (!video) return notFound(reply, "Video");
      const rows = await db
        .select()
        .from(clips)
        .where(and(eq(clips.videoId, video.id), eq(clips.userId, userId)))
        .orderBy(asc(clips.startSeconds));
      const subs = await subtitlesFor(
        rows.map((r) => r.id),
        userId,
      );
      return {
        clips: await Promise.all(
          rows.map((r) => toDto(r, subs.get(r.id), canEditClips(billing, request.user!) ? { video } : undefined)),
        ),
        urlsExpireInSeconds: URL_TTL_SECONDS,
        transcript: await transcriptFor(video.id, userId),
      } satisfies ClipListResponse;
    });

    app.patch("/clips/:id", async (request, reply) => {
      const params = IdParams.safeParse(request.params);
      if (!params.success) return notFound(reply);
      const input = ClipUpdateSchema.safeParse(request.body);
      if (!input.success) return sendValidationError(reply, input.error);
      const [row] = await db
        .update(clips)
        .set({
          ...(input.data.status ? { status: input.data.status } : {}),
          ...(input.data.title !== undefined ? { title: input.data.title ?? null } : {}),
        })
        .where(and(eq(clips.id, params.data.id), eq(clips.userId, request.user!.id)))
        .returning();
      if (!row) return notFound(reply);
      const subs = await subtitlesFor([row.id], request.user!.id);
      if (!canEditClips(billing, request.user!)) return toDto(row, subs.get(row.id));
      const [video] = await db
        .select({ sourceUrl: videos.sourceUrl, probe: videos.probe })
        .from(videos)
        .where(and(eq(videos.id, row.videoId), eq(videos.userId, request.user!.id)));
      return toDto(row, subs.get(row.id), { video });
    });

    app.get("/clips/:id/download", async (request, reply) => {
      const params = IdParams.safeParse(request.params);
      if (!params.success) return notFound(reply);
      const [row] = await db
        .select()
        .from(clips)
        .where(and(eq(clips.id, params.data.id), eq(clips.userId, request.user!.id)));
      // ?edited=1: la versión editada (modo viral).
      const edited = (request.query as { edited?: string } | undefined)?.edited === "1";
      const key = edited ? row?.editedS3Key : row?.s3Key;
      if (!row || !key) return notFound(reply);
      const name = `clipflow-${Math.round(row.startSeconds)}s-${Math.round(row.endSeconds)}s${edited ? "-viral" : ""}.mp4`;
      return { url: await storage.presignGet(key, URL_TTL_SECONDS, name), expiresInSeconds: URL_TTL_SECONDS };
    });

    // Editar clips (modo viral): un trabajo para el procesador con los clips elegidos. Solo administradores.
    app.post("/videos/:id/edit", async (request, reply) => {
      const params = IdParams.safeParse(request.params);
      if (!params.success) return notFound(reply, "Video");
      if (!canEditClips(billing, request.user!) || !deps.queue || !deps.launcher) {
        return sendError(reply, 403, "forbidden", "No tienes acceso a esta sección.");
      }
      const input = EditBody.safeParse(request.body);
      if (!input.success) return sendValidationError(reply, input.error);
      const userId = request.user!.id;
      const [video] = await db
        .select({ id: videos.id, sourceUrl: videos.sourceUrl, probe: videos.probe })
        .from(videos)
        .where(and(eq(videos.id, params.data.id), eq(videos.userId, userId)));
      if (!video) return notFound(reply, "Video");
      const rows = await db
        .select()
        .from(clips)
        .where(and(eq(clips.videoId, video.id), eq(clips.userId, userId), inArray(clips.id, input.data.clipIds)));
      const editable = rows.filter((r) => canEditClip(r, video));
      if (editable.length === 0) {
        return sendError(
          reply,
          409,
          "not_editable",
          "Estos clips se crearon antes del editor y su video original ya no está guardado. Vuelve a crear los clips del video para editarlos.",
        );
      }
      // Una edición a la vez por video.
      const [active] = await db
        .select({ id: processingJobs.id })
        .from(processingJobs)
        .where(
          and(
            eq(processingJobs.videoId, video.id),
            eq(processingJobs.userId, userId),
            eq(processingJobs.type, "render_clip"),
            inArray(processingJobs.status, ["queued", "processing"]),
          ),
        );
      if (active) return sendError(reply, 409, "already_editing", "Ya se están editando clips de este video. Espera a que termine.");
      const edit: ClipEditOptions = { mode: input.data.mode, music: input.data.music };
      const { job } = await createJob(db, {
        userId,
        videoId: video.id,
        type: "render_clip",
        idempotencyKey: `edit:${video.id}:${crypto.randomUUID()}`,
        params: { clipIds: editable.map((r) => r.id), edit },
      });
      if (!(await enqueue(deps.queue, job, request.log))) {
        return sendError(reply, 503, "queue_unavailable", "No se pudo enviar a procesar. Inténtalo en unos minutos.");
      }
      wakeWorkers(db, deps.launcher, request.log);
      return reply.code(201).send(toJobDto(job));
    });
  };
}
