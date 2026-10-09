import type { FastifyPluginAsync, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  DEFAULT_PRODUCT_CONFIG,
  isBillingExempt,
  type AnalysisPipeline,
  type JobParams,
  type JobResult,
  type ProductConfig,
  type SubtitleStyle,
} from "@clipflow/shared";
import { createJob, schema, type Database } from "@clipflow/shared/db";
import { sendError } from "./http.js";
import { enqueue, wakeWorkers } from "./jobs.js";
import type { WorkerLauncher } from "./launcher.js";
import type { JobQueue } from "./queue.js";
import type { VideoStorage } from "./storage.js";

const { videos, processingJobs, clips } = schema;

/** Versiones que compara la prueba lado a lado: la actual y la nueva. */
export const COMPARE_PIPELINES: AnalysisPipeline[] = ["classic", "v2"];
const COPY_PREFIX: Record<AnalysisPipeline, string> = { classic: "[Actual]", v2: "[Nueva]" };

const CompareBody = z.object({
  clipDurationSeconds: z.number().int().positive().optional(),
  subtitleStyle: z.enum(["highlight", "classic", "none"]).optional(),
});

/** USD por hora de video (redondeado a 4 decimales). */
const perHour = (usd: number | undefined, seconds: number) =>
  usd === undefined || seconds <= 0 ? null : Math.round((usd / (seconds / 3600)) * 10_000) / 10_000;

/**
 * Herramienta interna (solo los correos de BILLING_FREE_EMAILS, es decir, el dueño): procesar el MISMO
 * video con la versión actual y con la nueva y comparar clips y costo real por hora. Cada versión trabaja
 * sobre su propia copia del video (copia del original dentro de S3) y transcribe de nuevo, para que el
 * costo sea el real. Las copias aparecen en "Mis videos" y se borran como cualquier video.
 */
export function adminRoutes(deps: {
  db: Database;
  auth: preHandlerHookHandler;
  storage: VideoStorage;
  queue: JobQueue;
  launcher: WorkerLauncher;
  product?: ProductConfig;
  adminEmails?: string;
}): FastifyPluginAsync {
  const product = deps.product ?? DEFAULT_PRODUCT_CONFIG;
  const isAdmin = (request: FastifyRequest) => isBillingExempt(request.user?.email, deps.adminEmails);
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
      if ((source.status !== "uploaded" && source.status !== "ready") || source.sizeBytes <= 0) {
        return sendError(reply, 409, "not_processable", "Este video no se puede procesar.");
      }
      const duration = product.clipDurationsSeconds.includes(body.data.clipDurationSeconds ?? -1)
        ? body.data.clipDurationSeconds!
        : product.defaultClipDurationSeconds;
      const subtitleStyle: SubtitleStyle = body.data.subtitleStyle ?? "highlight";
      const comparisonId = crypto.randomUUID();
      const created: { pipeline: AnalysisPipeline; videoId: string; jobId: string }[] = [];
      for (const pipeline of COMPARE_PIPELINES) {
        // Copia propia del original dentro de S3 (sin descargarlo): cada versión es independiente.
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
            originalFilename: `${COPY_PREFIX[pipeline]} ${source.originalFilename.replace(/^\[(Actual|Nueva)\]\s*/, "")}`.slice(0, 255),
            mimeType: source.mimeType,
            sizeBytes: source.sizeBytes,
            durationSeconds: source.durationSeconds,
            width: source.width,
            height: source.height,
            s3Key,
            probe: source.probe,
            sourceUrl: source.sourceUrl,
            rightsConfirmedAt: source.rightsConfirmedAt,
            uploadedAt: source.uploadedAt ?? new Date(),
          })
          .returning();
        const jobParams: JobParams = { clipDurationSeconds: duration, subtitleStyle, pipeline, comparisonId, skipTranscriptCache: true };
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
      request.log.info({ comparisonId, videoId: source.id }, "prueba lado a lado iniciada");
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
        .limit(40);
      const jobIds = jobs.map((j) => j.job.id);
      const clipRows = jobIds.length
        ? await deps.db.select().from(clips).where(and(eq(clips.userId, userId), inArray(clips.jobId, jobIds)))
        : [];
      const groups = new Map<string, { comparisonId: string; createdAt: string; video: string; durationSeconds: number | null; variants: unknown[] }>();
      for (const { job, video } of jobs) {
        const params = job.params as JobParams;
        const result = job.result as JobResult | null;
        const seconds = video.durationSeconds ?? 0;
        const costs = result?.costs;
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
            video: video.originalFilename.replace(/^\[(Actual|Nueva)\]\s*/, ""),
            durationSeconds: video.durationSeconds,
            variants: [],
          });
        }
        const group = groups.get(id)!;
        group.durationSeconds ??= video.durationSeconds; // la mide el procesador al empezar
        group.variants.push({
          pipeline: params.pipeline ?? "classic",
          videoId: video.id,
          jobId: job.id,
          status: job.status,
          progress: job.progress,
          errorMessage: job.errorMessage,
          clipCount: result?.clipCount ?? null,
          ai: result?.ai ?? null,
          aiReason: result?.aiReason ?? null,
          models: result?.models ?? null,
          sounds: result?.sounds ?? null,
          analysisFrames: result?.analysisFrames ?? null,
          processingSeconds:
            job.startedAt && job.finishedAt ? Math.round((job.finishedAt.getTime() - job.startedAt.getTime()) / 1000) : null,
          costs: costs ?? null,
          // Costo real por hora de video: lo que se pagó en ESTE procesamiento, llevado a 60 min.
          perHour: costs
            ? {
                transcriptionUsd: perHour(costs.transcriptionUsd, seconds),
                analysisUsd: perHour(costs.textUsd + costs.visionUsd, seconds),
                computeUsd: perHour(costs.computeUsd, seconds),
                totalUsd: perHour(costs.totalUsd, seconds),
              }
            : null,
          clips: variantClips,
        });
      }
      // Siempre en el mismo orden: actual a la izquierda, nueva a la derecha.
      const comparisons = [...groups.values()].map((g) => ({
        ...g,
        variants: (g.variants as { pipeline: AnalysisPipeline }[]).sort(
          (a, b) => COMPARE_PIPELINES.indexOf(a.pipeline) - COMPARE_PIPELINES.indexOf(b.pipeline),
        ),
      }));
      return { comparisons };
    });
  };
}
