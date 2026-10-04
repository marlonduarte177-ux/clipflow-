import type { FastifyPluginAsync, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { DEFAULT_PRODUCT_CONFIG, type JobParams, type JobResult, type ProductConfig, type SubtitleStyle } from "@clipflow/shared";
import { createJob, schema, type Database } from "@clipflow/shared/db";
import { sendError } from "./http.js";
import { enqueue, wakeWorkers } from "./jobs.js";
import type { WorkerLauncher } from "./launcher.js";
import type { JobQueue } from "./queue.js";
import type { VideoStorage } from "./storage.js";

const { videos, processingJobs, clips } = schema;

/** Nombre corto de cada pipeline para el título de la copia. */
export function pipelineLabel(pipeline: string): string {
  if (pipeline === "classic") return "Actual";
  const model = pipeline.split(":")[1];
  if (!model) return "Gemini";
  return model
    .replace(/^gemini-/, "Gemini ")
    .replace(/-flash-lite$/, " Flash-Lite")
    .replace(/-flash$/, " Flash")
    .replace(/-pro$/, " Pro");
}

const CompareBody = z.object({
  clipDurationSeconds: z.number().int().positive().optional(),
  subtitleStyle: z.enum(["highlight", "classic", "none"]).optional(),
});

/**
 * Herramienta interna (solo correos en ADMIN_EMAILS): procesar el MISMO video con cada pipeline y
 * comparar clips y costos. Cada pipeline trabaja sobre una copia del video (copia del original dentro de
 * S3). Las copias aparecen en "Mis videos" del administrador y se borran como cualquier video.
 */
export function adminRoutes(deps: {
  db: Database;
  auth: preHandlerHookHandler;
  storage: VideoStorage;
  queue: JobQueue;
  launcher: WorkerLauncher;
  product?: ProductConfig;
  adminEmails: string[];
  comparePipelines: string[];
}): FastifyPluginAsync {
  const product = deps.product ?? DEFAULT_PRODUCT_CONFIG;
  const isAdmin = (request: FastifyRequest) => {
    const email = request.user?.email?.toLowerCase();
    return Boolean(email && deps.adminEmails.includes(email));
  };
  const forbid = (reply: FastifyReply) => sendError(reply, 403, "forbidden", "No tienes acceso a esta sección.");

  return async (app) => {
    app.addHook("preHandler", deps.auth);

    app.get("/admin/me", async (request) => ({ admin: isAdmin(request) }));

    app.post("/admin/compare/:videoId", async (request, reply) => {
      if (!isAdmin(request)) return forbid(reply);
      const params = z.object({ videoId: z.uuid() }).safeParse(request.params);
      if (!params.success) return sendError(reply, 404, "not_found", "Video no encontrado.");
      const body = CompareBody.safeParse(request.body ?? {});
      if (!body.success) return sendError(reply, 400, "validation_error", "Datos inválidos.");
      const userId = request.user!.id;
      const [source] = await deps.db
        .select()
        .from(videos)
        .where(and(eq(videos.id, params.data.videoId), eq(videos.userId, userId)));
      if (!source) return sendError(reply, 404, "not_found", "Video no encontrado.");
      if (source.status !== "uploaded" && source.status !== "ready") {
        return sendError(reply, 409, "not_processable", "Este video no se puede procesar.");
      }
      const duration = product.clipDurationsSeconds.includes(body.data.clipDurationSeconds ?? -1)
        ? body.data.clipDurationSeconds!
        : product.defaultClipDurationSeconds;
      const subtitleStyle: SubtitleStyle = body.data.subtitleStyle ?? "highlight";
      const comparisonId = crypto.randomUUID();
      const created: { pipeline: string; videoId: string; jobId: string }[] = [];
      for (const pipeline of deps.comparePipelines) {
        // Copia propia del original dentro de S3 (sin descargarlo): cada video es independiente.
        const copyId = crypto.randomUUID();
        const extension = source.s3Key.split(".").pop() ?? "mp4";
        const s3Key = `originals/${userId}/${copyId}/original.${extension}`;
        await deps.storage.copyObject(source.s3Key, s3Key, source.sizeBytes);
        const [copy] = await deps.db
          .insert(videos)
          .values({
            id: copyId,
            userId,
            projectId: source.projectId,
            status: source.status,
            originalFilename: `[${pipelineLabel(pipeline)}] ${source.originalFilename}`.slice(0, 255),
            mimeType: source.mimeType,
            sizeBytes: source.sizeBytes,
            durationSeconds: source.durationSeconds,
            s3Key,
            probe: source.probe,
            sourceUrl: source.sourceUrl,
            rightsConfirmedAt: source.rightsConfirmedAt,
            uploadedAt: source.uploadedAt ?? new Date(),
          })
          .returning();
        const jobParams: JobParams = {
          clipDurationSeconds: duration,
          subtitleStyle,
          pipeline,
          comparisonId,
          skipTranscriptCache: true,
        };
        const { job } = await createJob(deps.db, {
          userId,
          videoId: copy!.id,
          type: "analyze_video",
          idempotencyKey: `compare:${comparisonId}:${pipeline}`,
          params: { ...jobParams },
        });
        await enqueue(deps.queue, job, request.log);
        created.push({ pipeline, videoId: copy!.id, jobId: job.id });
      }
      wakeWorkers(deps.db, deps.launcher, request.log);
      request.log.info({ comparisonId, videoId: source.id, pipelines: deps.comparePipelines }, "prueba lado a lado iniciada");
      return reply.code(201).send({ comparisonId, variants: created });
    });

    app.get("/admin/comparisons", async (request, reply) => {
      if (!isAdmin(request)) return forbid(reply);
      const userId = request.user!.id;
      const jobs = await deps.db
        .select({ job: processingJobs, video: videos })
        .from(processingJobs)
        .innerJoin(videos, and(eq(videos.id, processingJobs.videoId), eq(videos.userId, processingJobs.userId)))
        .where(and(eq(processingJobs.userId, userId), sql`${processingJobs.params}->>'comparisonId' is not null`))
        .orderBy(desc(processingJobs.createdAt))
        .limit(60);
      const jobIds = jobs.map((j) => j.job.id);
      const clipRows = jobIds.length
        ? await deps.db.select().from(clips).where(and(eq(clips.userId, userId), inArray(clips.jobId, jobIds)))
        : [];
      const groups = new Map<string, { comparisonId: string; createdAt: string; video: string; variants: unknown[] }>();
      for (const { job, video } of jobs) {
        const params = job.params as JobParams;
        const result = job.result as JobResult | null;
        const minutes = (video.durationSeconds ?? 0) / 60;
        const costs = result?.costs;
        const aiUsd = costs ? costs.transcriptionUsd + costs.textUsd + costs.visionUsd : null;
        const variantClips = await Promise.all(
          clipRows
            .filter((c) => c.jobId === job.id)
            .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
            .map(async (c) => ({
              id: c.id,
              title: c.title,
              startSeconds: c.startSeconds,
              endSeconds: c.endSeconds,
              score: c.score,
              reason: c.aiReason,
              thumbnailUrl: c.thumbnailS3Key ? await deps.storage.presignGet(c.thumbnailS3Key, 3600) : null,
              videoUrl: c.s3Key ? await deps.storage.presignGet(c.s3Key, 3600) : null,
            })),
        );
        const id = params.comparisonId!;
        if (!groups.has(id)) {
          groups.set(id, {
            comparisonId: id,
            createdAt: job.createdAt.toISOString(),
            video: video.originalFilename.replace(/^\[[^\]]+\]\s*/, ""),
            variants: [],
          });
        }
        groups.get(id)!.variants.push({
          pipeline: params.pipeline ?? "classic",
          label: pipelineLabel(params.pipeline ?? "classic"),
          videoId: video.id,
          jobId: job.id,
          status: job.status,
          progress: job.progress,
          errorMessage: job.errorMessage,
          durationSeconds: video.durationSeconds,
          clipCount: result?.clipCount ?? null,
          providers: result?.providers ?? null,
          ai: result?.ai ?? null,
          costs: costs ?? null,
          totalUsdPerMinute: costs && minutes > 0 ? costs.totalUsd / minutes : null,
          aiUsdPerMinute: aiUsd !== null && minutes > 0 ? aiUsd / minutes : null,
          clips: variantClips,
        });
      }
      return { comparisons: [...groups.values()] };
    });
  };
}
