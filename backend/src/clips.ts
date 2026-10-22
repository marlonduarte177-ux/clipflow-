import type { FastifyInstance, FastifyReply, preHandlerHookHandler } from "fastify";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { ClipUpdateSchema, fullTranscriptKey, type ClipDto, type ClipListResponse, type JobResult } from "@clipflow/shared";
import { schema, type Database } from "@clipflow/shared/db";
import { sendError, sendValidationError } from "./http.js";
import type { VideoStorage } from "./storage.js";

const { clips, subtitles, videos, processingJobs } = schema;
type ClipRow = typeof clips.$inferSelect;
const IdParams = z.object({ id: z.uuid() });

/** Las URLs de preview caducan pronto: la web las vuelve a pedir si hace falta. */
const URL_TTL_SECONDS = 15 * 60;

export function clipRoutes(deps: { db: Database; auth: preHandlerHookHandler; storage: VideoStorage }) {
  const { db, storage } = deps;
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

  async function toDto(row: ClipRow, subs?: { srt?: string; vtt?: string }): Promise<ClipDto> {
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
        .select({ id: videos.id })
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
        clips: await Promise.all(rows.map((r) => toDto(r, subs.get(r.id)))),
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
      return toDto(row, subs.get(row.id));
    });

    app.get("/clips/:id/download", async (request, reply) => {
      const params = IdParams.safeParse(request.params);
      if (!params.success) return notFound(reply);
      const [row] = await db
        .select()
        .from(clips)
        .where(and(eq(clips.id, params.data.id), eq(clips.userId, request.user!.id)));
      if (!row?.s3Key) return notFound(reply);
      const name = `clipflow-${Math.round(row.startSeconds)}s-${Math.round(row.endSeconds)}s.mp4`;
      return { url: await storage.presignGet(row.s3Key, URL_TTL_SECONDS, name), expiresInSeconds: URL_TTL_SECONDS };
    });
  };
}
