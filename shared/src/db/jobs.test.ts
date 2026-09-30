import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { DbHandle } from "./client.js";
import { createTestDb } from "./testing.js";
import { processingJobs, projects, videos } from "./schema.js";
import { upsertUser } from "./users.js";
import {
  claimJob,
  completeJob,
  createJob,
  failJob,
  markJobCancelled,
  reportProgress,
  requestCancel,
  resetJobForRetry,
} from "./jobs.js";

let h: DbHandle | undefined;
beforeEach(async () => {
  await h?.close();
  h = await createTestDb();
});
afterAll(async () => {
  await h?.close();
});
const db = () => h!.db;

async function setup(sub = "u") {
  const user = await upsertUser(db(), { cognitoSub: sub });
  const [project] = await db().insert(projects).values({ userId: user.id, name: "P" }).returning();
  const [video] = await db()
    .insert(videos)
    .values({
      userId: user.id,
      projectId: project!.id,
      originalFilename: "v.mp4",
      mimeType: "video/mp4",
      sizeBytes: 10,
      s3Key: `originals/${user.id}/${sub}.mp4`,
      status: "uploaded",
    })
    .returning();
  const { job } = await createJob(db(), { userId: user.id, videoId: video!.id, type: "analyze_video", idempotencyKey: `k-${sub}` });
  return { user, video: video!, job };
}

describe("trabajos", () => {
  it("crear con la misma clave devuelve el mismo trabajo", async () => {
    const { user, video, job } = await setup();
    const again = await createJob(db(), { userId: user.id, videoId: video.id, type: "analyze_video", idempotencyKey: "k-u" });
    expect(again.created).toBe(false);
    expect(again.job.id).toBe(job.id);
  });

  it("solo un worker puede reclamar un trabajo (aunque lo intenten 5 a la vez)", async () => {
    const { job } = await setup();
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => claimJob(db(), job.id, `w${i}`)));
    const winners = results.filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({ status: "processing", attempts: 1, stage: "preparing" });
  });

  it("un trabajo de un worker caído (sin latido) puede retomarse; uno activo no", async () => {
    const { job } = await setup();
    await claimJob(db(), job.id, "w1");
    expect(await claimJob(db(), job.id, "w2")).toBeUndefined();
    await db().update(processingJobs).set({ heartbeatAt: sql`now() - interval '10 minutes'` }).where(eq(processingJobs.id, job.id));
    const retaken = await claimJob(db(), job.id, "w2");
    expect(retaken).toMatchObject({ lockedBy: "w2", attempts: 2 });
    // El worker original ya no puede escribir.
    expect(await reportProgress(db(), job.id, "w1", { stage: "analyzing", progress: 50 })).toBe("lost");
  });

  it("el progreso real nunca retrocede y no llega a 100 hasta completar", async () => {
    const { job } = await setup();
    await claimJob(db(), job.id, "w");
    await reportProgress(db(), job.id, "w", { stage: "analyzing", progress: 40 });
    await reportProgress(db(), job.id, "w", { stage: "analyzing", progress: 20 });
    await reportProgress(db(), job.id, "w", { stage: "rendering_clips", progress: 150 });
    let [row] = await db().select().from(processingJobs).where(eq(processingJobs.id, job.id));
    expect(row).toMatchObject({ progress: 99, stage: "rendering_clips" });
    expect(await completeJob(db(), job.id, "w")).toBe(true);
    [row] = await db().select().from(processingJobs).where(eq(processingJobs.id, job.id));
    expect(row).toMatchObject({ status: "completed", progress: 100, lockedBy: null });
  });

  it("cancelar en cola es inmediato; procesando avisa al worker", async () => {
    const a = await setup("a");
    expect((await requestCancel(db(), a.job.id, a.user.id))?.status).toBe("cancelled");
    expect(await claimJob(db(), a.job.id, "w")).toBeUndefined();

    const b = await setup("b");
    await claimJob(db(), b.job.id, "w");
    expect((await requestCancel(db(), b.job.id, b.user.id))?.status).toBe("processing");
    expect(await reportProgress(db(), b.job.id, "w", { stage: "analyzing", progress: 30 })).toBe("cancel");
    await markJobCancelled(db(), b.job.id, "w");
    const [row] = await db().select().from(processingJobs).where(eq(processingJobs.id, b.job.id));
    expect(row!.status).toBe("cancelled");
  });

  it("otro usuario no puede cancelar ni reintentar", async () => {
    const a = await setup("a");
    const b = await setup("b");
    expect(await requestCancel(db(), a.job.id, b.user.id)).toBeUndefined();
    await claimJob(db(), a.job.id, "w");
    await failJob(db(), a.job.id, "w", { code: "x", message: "x", retryable: false });
    expect(await resetJobForRetry(db(), a.job.id, b.user.id)).toBeUndefined();
  });

  it("un fallo reintentable vuelve a la cola hasta agotar los intentos", async () => {
    const { user, job } = await setup();
    const err = { code: "network", message: "Error temporal", retryable: true };
    for (let i = 1; i <= 2; i++) {
      await claimJob(db(), job.id, "w");
      expect(await failJob(db(), job.id, "w", err)).toBe("requeued");
    }
    await claimJob(db(), job.id, "w");
    expect(await failJob(db(), job.id, "w", err)).toBe("failed"); // 3 de 3
    expect(await claimJob(db(), job.id, "w")).toBeUndefined();

    // El usuario puede reintentar un trabajo fallido.
    const retried = await resetJobForRetry(db(), job.id, user.id);
    expect(retried).toMatchObject({ status: "queued", attempts: 0, errorMessage: null });
    expect(await claimJob(db(), job.id, "w")).toBeDefined();
  });

  it("un fallo no reintentable falla de inmediato con mensaje para el usuario", async () => {
    const { job } = await setup();
    await claimJob(db(), job.id, "w");
    expect(await failJob(db(), job.id, "w", { code: "invalid_video", message: "No es un video válido.", retryable: false })).toBe("failed");
    const [row] = await db().select().from(processingJobs).where(eq(processingJobs.id, job.id));
    expect(row).toMatchObject({ status: "failed", errorCode: "invalid_video", errorMessage: "No es un video válido." });
  });

  it("no se puede reintentar un trabajo que sigue en proceso", async () => {
    const { user, job } = await setup();
    await claimJob(db(), job.id, "w");
    expect(await resetJobForRetry(db(), job.id, user.id)).toBeUndefined();
  });
});
