import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Database, DbExecutor } from "./client.js";
import { jobStage, jobType, processingJobs } from "./schema.js";

export type Job = typeof processingJobs.$inferSelect;
export type JobStage = (typeof jobStage.enumValues)[number];
export type JobType = (typeof jobType.enumValues)[number];

/** Si un worker no da señales durante este tiempo, se considera caído y su trabajo se puede retomar. */
export const HEARTBEAT_TIMEOUT_SECONDS = 180;

/**
 * Crea un trabajo o devuelve el existente con la misma clave (evita duplicados por doble clic
 * o reintentos de red).
 */
export async function createJob(
  db: DbExecutor,
  input: { userId: string; videoId: string; type: JobType; idempotencyKey: string; params?: Record<string, unknown> },
): Promise<{ job: Job; created: boolean }> {
  const [inserted] = await db
    .insert(processingJobs)
    .values({
      userId: input.userId,
      videoId: input.videoId,
      type: input.type,
      idempotencyKey: input.idempotencyKey,
      params: input.params ?? {},
    })
    .onConflictDoNothing({ target: processingJobs.idempotencyKey })
    .returning();
  if (inserted) return { job: inserted, created: true };
  const [existing] = await db
    .select()
    .from(processingJobs)
    .where(eq(processingJobs.idempotencyKey, input.idempotencyKey));
  if (!existing || existing.userId !== input.userId) throw new Error("Clave de idempotencia en conflicto");
  return { job: existing, created: false };
}

/**
 * Un worker "reclama" un trabajo de forma atómica. Solo uno puede ganar:
 * - trabajos en cola, o
 * - trabajos "processing" cuyo worker dejó de dar señales (se cayó).
 * Devuelve undefined si el trabajo ya lo tiene otro, terminó, se canceló o agotó sus intentos.
 */
export async function claimJob(db: Database, jobId: string, workerId: string): Promise<Job | undefined> {
  const staleBefore = sql`now() - make_interval(secs => ${HEARTBEAT_TIMEOUT_SECONDS})`;
  const [job] = await db
    .update(processingJobs)
    .set({
      status: "processing",
      attempts: sql`${processingJobs.attempts} + 1`,
      lockedBy: workerId,
      heartbeatAt: sql`now()`,
      startedAt: sql`coalesce(${processingJobs.startedAt}, now())`,
      stage: "preparing",
      progress: 0,
      errorCode: null,
      errorMessage: null,
    })
    .where(
      and(
        eq(processingJobs.id, jobId),
        isNull(processingJobs.cancelRequestedAt),
        lt(processingJobs.attempts, processingJobs.maxAttempts),
        or(
          eq(processingJobs.status, "queued"),
          and(eq(processingJobs.status, "processing"), lt(processingJobs.heartbeatAt, staleBefore)),
        ),
      ),
    )
    .returning();
  return job;
}

/**
 * Latido + progreso real. Devuelve lo que el worker debe hacer:
 * - "continue": seguir.
 * - "cancel": el usuario pidió cancelar.
 * - "lost": otro worker tomó el trabajo o ya no está en proceso (dejar de trabajar).
 */
export async function reportProgress(
  db: Database,
  jobId: string,
  workerId: string,
  update: { stage: JobStage; progress: number },
): Promise<"continue" | "cancel" | "lost"> {
  const progress = Math.max(0, Math.min(99, Math.floor(update.progress)));
  const [row] = await db
    .update(processingJobs)
    .set({
      stage: update.stage,
      // El progreso nunca retrocede.
      progress: sql`greatest(${processingJobs.progress}, ${progress})`,
      heartbeatAt: sql`now()`,
    })
    .where(and(eq(processingJobs.id, jobId), eq(processingJobs.lockedBy, workerId), eq(processingJobs.status, "processing")))
    .returning({ cancelRequestedAt: processingJobs.cancelRequestedAt });
  if (!row) return "lost";
  return row.cancelRequestedAt ? "cancel" : "continue";
}

function ownedBy(jobId: string, workerId: string) {
  return and(eq(processingJobs.id, jobId), eq(processingJobs.lockedBy, workerId), eq(processingJobs.status, "processing"));
}

export async function completeJob(db: DbExecutor, jobId: string, workerId: string): Promise<boolean> {
  const rows = await db
    .update(processingJobs)
    .set({ status: "completed", stage: "finalizing", progress: 100, finishedAt: sql`now()`, lockedBy: null })
    .where(ownedBy(jobId, workerId))
    .returning({ id: processingJobs.id });
  return rows.length > 0;
}

/**
 * Registra un fallo. Si es reintentable y quedan intentos, vuelve a la cola;
 * si no, queda "failed" con un mensaje apto para el usuario.
 */
export async function failJob(
  db: Database,
  jobId: string,
  workerId: string,
  error: { code: string; message: string; retryable: boolean },
): Promise<"requeued" | "failed" | "lost"> {
  const [row] = await db
    .update(processingJobs)
    .set({
      status: sql`case when ${error.retryable} and ${processingJobs.attempts} < ${processingJobs.maxAttempts}
        then 'queued'::job_status else 'failed'::job_status end`,
      finishedAt: sql`case when ${error.retryable} and ${processingJobs.attempts} < ${processingJobs.maxAttempts}
        then null else now() end`,
      errorCode: error.code,
      errorMessage: error.message,
      lockedBy: null,
    })
    .where(ownedBy(jobId, workerId))
    .returning({ status: processingJobs.status });
  if (!row) return "lost";
  return row.status === "queued" ? "requeued" : "failed";
}

export async function markJobCancelled(db: DbExecutor, jobId: string, workerId: string): Promise<void> {
  await db
    .update(processingJobs)
    .set({ status: "cancelled", finishedAt: sql`now()`, lockedBy: null })
    .where(ownedBy(jobId, workerId));
}

/**
 * El usuario pide cancelar. En cola → se cancela ya. Procesando → se marca y el worker
 * se detiene en su próximo latido. Devuelve el trabajo actualizado o undefined si no se podía.
 */
export async function requestCancel(db: DbExecutor, jobId: string, userId: string): Promise<Job | undefined> {
  const [row] = await db
    .update(processingJobs)
    .set({
      cancelRequestedAt: sql`now()`,
      status: sql`case when ${processingJobs.status} = 'queued' then 'cancelled'::job_status else ${processingJobs.status} end`,
      finishedAt: sql`case when ${processingJobs.status} = 'queued' then now() else ${processingJobs.finishedAt} end`,
    })
    .where(
      and(
        eq(processingJobs.id, jobId),
        eq(processingJobs.userId, userId),
        or(eq(processingJobs.status, "queued"), eq(processingJobs.status, "processing")),
      ),
    )
    .returning();
  return row;
}

/** Reintento pedido por el usuario: solo para trabajos fallidos o cancelados. Reinicia los intentos. */
export async function resetJobForRetry(db: DbExecutor, jobId: string, userId: string): Promise<Job | undefined> {
  const [row] = await db
    .update(processingJobs)
    .set({
      status: "queued",
      stage: null,
      progress: 0,
      attempts: 0,
      errorCode: null,
      errorMessage: null,
      cancelRequestedAt: null,
      finishedAt: null,
      startedAt: null,
      lockedBy: null,
      heartbeatAt: null,
      queuedAt: sql`now()`,
    })
    .where(
      and(
        eq(processingJobs.id, jobId),
        eq(processingJobs.userId, userId),
        or(eq(processingJobs.status, "failed"), eq(processingJobs.status, "cancelled")),
      ),
    )
    .returning();
  return row;
}
