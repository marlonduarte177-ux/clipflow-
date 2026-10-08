import type { FastifyInstance, FastifyReply, preHandlerHookHandler } from "fastify";
import { and, count, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { JobDto, JobListResponse } from "@clipflow/shared";
import { requestCancel, resetJobForRetry, schema, type Database, type Job } from "@clipflow/shared/db";
import { replyIfBlocked, type BillingSettings } from "./billing.js";
import { sendError } from "./http.js";
import type { WorkerLauncher } from "./launcher.js";
import type { JobQueue } from "./queue.js";

const { processingJobs } = schema;
const IdParams = z.object({ id: z.uuid() });
const ListQuery = z.object({ videoId: z.uuid().optional() });

/** Un trabajo en cola durante más de esto sin empezar se considera atascado y se puede reenviar. */
const STUCK_QUEUED_MS = 5 * 60 * 1000;

export function toJobDto(job: Job): JobDto {
  return {
    id: job.id,
    videoId: job.videoId,
    type: job.type,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    errorMessage: job.errorMessage,
    params: job.params as JobDto["params"],
    result: (job.result as JobDto["result"]) ?? null,
    queuedAt: job.queuedAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

/**
 * Envía el trabajo a la cola. Si SQS falla, el trabajo queda "queued" en la base
 * y el usuario puede reenviarlo con "Reintentar" (no se pierde).
 */
export async function enqueue(queue: JobQueue, job: Job, log: FastifyInstance["log"]): Promise<boolean> {
  try {
    await queue.send(job.id);
    log.info({ jobId: job.id, videoId: job.videoId }, "trabajo encolado");
    return true;
  } catch (err) {
    log.error({ jobId: job.id, reason: (err as Error).name }, "no se pudo encolar el trabajo");
    return false;
  }
}

/**
 * Enciende procesadores según los trabajos en cola (1 por cada trabajo, hasta el máximo).
 * No bloquea la respuesta: si falla, el escalado por métricas de la cola hace de respaldo.
 */
export function wakeWorkers(db: Database, launcher: WorkerLauncher, log: FastifyInstance["log"]): void {
  void (async () => {
    const [row] = await db.select({ n: count() }).from(processingJobs).where(eq(processingJobs.status, "queued"));
    const result = await launcher.ensureRunning(Math.max(1, row?.n ?? 0));
    if (result.started > 0) log.info(result, "procesadores encendidos");
  })().catch((err: Error) => log.warn({ reason: err.name }, "no se pudo encender un procesador"));
}

export function jobRoutes(deps: {
  db: Database;
  auth: preHandlerHookHandler;
  queue: JobQueue;
  launcher: WorkerLauncher;
  billing: BillingSettings;
}) {
  const { db, queue, launcher, billing } = deps;
  const notFound = (reply: FastifyReply) => sendError(reply, 404, "not_found", "Trabajo no encontrado.");

  async function findOwnJob(id: string, userId: string) {
    const [row] = await db
      .select()
      .from(processingJobs)
      .where(and(eq(processingJobs.id, id), eq(processingJobs.userId, userId)));
    return row;
  }

  return async (app: FastifyInstance) => {
    app.addHook("preHandler", deps.auth);

    app.get("/jobs", async (request, reply) => {
      const query = ListQuery.safeParse(request.query);
      if (!query.success) return sendError(reply, 400, "validation_error", "Parámetros inválidos.");
      const rows = await db
        .select()
        .from(processingJobs)
        .where(
          and(
            eq(processingJobs.userId, request.user!.id),
            query.data.videoId ? eq(processingJobs.videoId, query.data.videoId) : undefined,
          ),
        )
        .orderBy(desc(processingJobs.createdAt))
        .limit(100);
      return { jobs: rows.map(toJobDto) } satisfies JobListResponse;
    });

    app.get("/jobs/:id", async (request, reply) => {
      const params = IdParams.safeParse(request.params);
      if (!params.success) return notFound(reply);
      const job = await findOwnJob(params.data.id, request.user!.id);
      return job ? toJobDto(job) : notFound(reply);
    });

    app.post("/jobs/:id/cancel", async (request, reply) => {
      const params = IdParams.safeParse(request.params);
      if (!params.success) return notFound(reply);
      const job = await requestCancel(db, params.data.id, request.user!.id);
      if (job) return toJobDto(job);
      const existing = await findOwnJob(params.data.id, request.user!.id);
      return existing
        ? sendError(reply, 409, "not_cancellable", "Este trabajo ya terminó.")
        : notFound(reply);
    });

    app.post("/jobs/:id/retry", async (request, reply) => {
      const params = IdParams.safeParse(request.params);
      if (!params.success) return notFound(reply);
      const userId = request.user!.id;
      const existing = await findOwnJob(params.data.id, userId);
      if (!existing) return notFound(reply);
      const downloadOnly = (existing.params as { downloadOnly?: boolean } | null)?.downloadOnly === true;
      if (!downloadOnly && (await replyIfBlocked(db, billing, request.user!, reply))) return reply;

      let job: Job | undefined;
      if (existing.status === "queued" && Date.now() - existing.queuedAt.getTime() > STUCK_QUEUED_MS) {
        job = existing; // nunca llegó al worker: se reenvía tal cual
      } else {
        job = await resetJobForRetry(db, existing.id, userId);
      }
      if (!job) return sendError(reply, 409, "not_retryable", "Solo se pueden reintentar trabajos fallidos, cancelados o que terminaron sin análisis de IA.");
      if (!(await enqueue(queue, job, request.log))) {
        return sendError(reply, 503, "queue_unavailable", "No se pudo enviar a procesar. Inténtalo en unos minutos.");
      }
      wakeWorkers(db, launcher, request.log);
      return toJobDto(job);
    });
  };
}
