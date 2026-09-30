import type { FastifyInstance, FastifyReply, preHandlerHookHandler } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { ClipUpdateSchema, type ClipDto, type ClipListResponse } from "@clipflow/shared";
import { schema, type Database } from "@clipflow/shared/db";
import { sendError, sendValidationError } from "./http.js";
import type { VideoStorage } from "./storage.js";

const { clips, videos } = schema;
type ClipRow = typeof clips.$inferSelect;
const IdParams = z.object({ id: z.uuid() });

/** Las URLs de preview caducan pronto: la web las vuelve a pedir si hace falta. */
const URL_TTL_SECONDS = 15 * 60;

export function clipRoutes(deps: { db: Database; auth: preHandlerHookHandler; storage: VideoStorage }) {
  const { db, storage } = deps;
  const notFound = (reply: FastifyReply, what = "Clip") => sendError(reply, 404, "not_found", `${what} no encontrado.`);

  async function toDto(row: ClipRow): Promise<ClipDto> {
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
      return { clips: await Promise.all(rows.map(toDto)), urlsExpireInSeconds: URL_TTL_SECONDS } satisfies ClipListResponse;
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
      return row ? toDto(row) : notFound(reply);
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
