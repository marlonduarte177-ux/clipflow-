import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { DEFAULT_PRODUCT_CONFIG } from "@clipflow/shared";
import { claimJob, completeJob, schema } from "@clipflow/shared/db";
import { BILLING_OFF } from "./billing.js";
import { bearer, closeTestApp, createTestApp, type TestContext } from "./test-helpers.js";

const MiB = 1024 * 1024;
let ctx: TestContext | undefined;
afterEach(async () => {
  await closeTestApp(ctx);
  ctx = undefined;
});

/** Video subido del dueño (sub "dueno" → dueno@example.com en los tests, que está en los correos exentos). */
async function ownerVideo() {
  ctx = await createTestApp(DEFAULT_PRODUCT_CONFIG, { ...BILLING_OFF, BILLING_FREE_EMAILS: "Dueno@example.com" });
  const app = ctx.app;
  const project = (await app.inject({ method: "POST", url: "/projects", headers: bearer("dueno"), payload: { name: "P" } })).json().id;
  const { video } = (
    await app.inject({
      method: "POST",
      url: "/videos",
      headers: bearer("dueno"),
      payload: { projectId: project, filename: "stream.mp4", sizeBytes: 20 * MiB, mimeType: "video/mp4", durationSeconds: 1800 },
    })
  ).json();
  ctx.storage.forceSize = 20 * MiB;
  await app.inject({
    method: "POST",
    url: `/videos/${video.id}/complete`,
    headers: bearer("dueno"),
    payload: { parts: [1, 2].map((n) => ({ partNumber: n, etag: "e" })) },
  });
  return video.id as string;
}

describe("prueba lado a lado de la versión actual y la nueva (solo el dueño)", () => {
  it("otro usuario no puede usarla", async () => {
    const videoId = await ownerVideo();
    const app = ctx!.app;
    expect((await app.inject({ method: "GET", url: "/admin/me", headers: bearer("alice") })).json()).toEqual({ admin: false });
    expect((await app.inject({ method: "POST", url: `/admin/compare/${videoId}`, headers: bearer("alice") })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/admin/comparisons", headers: bearer("alice") })).statusCode).toBe(403);
  });

  it("procesa el mismo video con cada versión (cada una con su copia) y muestra clips y costo real por hora", async () => {
    const videoId = await ownerVideo();
    const app = ctx!.app;
    const db = ctx!.database.db;
    expect((await app.inject({ method: "GET", url: "/admin/me", headers: bearer("dueno") })).json()).toEqual({ admin: true });

    const res = await app.inject({ method: "POST", url: `/admin/compare/${videoId}`, headers: bearer("dueno"), payload: { clipDurationSeconds: 60 } });
    expect(res.statusCode).toBe(201);
    const { comparisonId, variants } = res.json();
    expect(variants.map((v: { pipeline: string }) => v.pipeline)).toEqual(["classic", "v2"]);

    const [source] = await db.select().from(schema.videos).where(eq(schema.videos.id, videoId));
    for (const v of variants) {
      const [copy] = await db.select().from(schema.videos).where(eq(schema.videos.id, v.videoId));
      expect(copy!.s3Key).not.toBe(source!.s3Key);
      expect(copy!.s3Key).toContain(`/${v.videoId}/`);
      expect(ctx!.storage.objects.has(copy!.s3Key)).toBe(true);
      const [job] = await db.select().from(schema.processingJobs).where(eq(schema.processingJobs.id, v.jobId));
      expect(job!.params).toMatchObject({ pipeline: v.pipeline, comparisonId, skipTranscriptCache: true, clipDurationSeconds: 60 });
    }
    const names = await Promise.all(
      variants.map(async (v: { videoId: string }) => (await db.select().from(schema.videos).where(eq(schema.videos.id, v.videoId)))[0]!.originalFilename),
    );
    expect(names).toEqual(["[Actual] stream.mp4", "[Nueva] stream.mp4"]);
    expect(ctx!.queue.sent).toEqual(expect.arrayContaining(variants.map((v: { jobId: string }) => v.jobId)));

    // El procesador termina la versión nueva (30 min de video).
    const v2 = variants[1];
    await db.update(schema.videos).set({ status: "ready", durationSeconds: 1800 }).where(eq(schema.videos.id, v2.videoId));
    await claimJob(db, v2.jobId, "w");
    await completeJob(db, v2.jobId, "w", {
      clipCount: 1,
      ai: "used",
      pipeline: "v2",
      models: { transcription: "whisper-1", analysis: "gpt-6.1-sol" },
      sounds: { laughter: 4, scream: 2 },
      analysisFrames: 360,
      costs: { transcriptionUsd: 0.18, textUsd: 0.1, visionUsd: 0, computeUsd: 0.02, totalUsd: 0.3 },
    });
    await db.insert(schema.clips).values({
      userId: source!.userId,
      videoId: v2.videoId,
      jobId: v2.jobId,
      title: "¡No lo puede creer!",
      startSeconds: 10,
      endSeconds: 70,
      score: 0.95,
      aiReason: "Gol y gritos.",
      s3Key: "clips/x/0.mp4",
    });

    const list = (await app.inject({ method: "GET", url: "/admin/comparisons", headers: bearer("dueno") })).json();
    expect(list.comparisons).toHaveLength(1);
    expect(list.comparisons[0]).toMatchObject({ video: "stream.mp4", durationSeconds: 1800 });
    const [classic, fresh] = list.comparisons[0].variants;
    expect(classic).toMatchObject({ pipeline: "classic", status: "queued", costs: null });
    expect(fresh).toMatchObject({
      pipeline: "v2",
      status: "completed",
      clipCount: 1,
      models: { analysis: "gpt-6.1-sol" },
      sounds: { laughter: 4, scream: 2 },
      analysisFrames: 360,
      // 0,30 USD por media hora = 0,60 USD por hora de video.
      perHour: { transcriptionUsd: 0.36, analysisUsd: 0.2, computeUsd: 0.04, totalUsd: 0.6 },
    });
    expect(fresh.clips[0]).toMatchObject({ title: "¡No lo puede creer!", reason: "Gol y gritos." });
    expect(fresh.clips[0].videoUrl).toContain("clips/x/0.mp4");
  });

  it("no compara un video que todavía no terminó de subirse", async () => {
    ctx = await createTestApp(DEFAULT_PRODUCT_CONFIG, { ...BILLING_OFF, BILLING_FREE_EMAILS: "dueno@example.com" });
    const app = ctx.app;
    const project = (await app.inject({ method: "POST", url: "/projects", headers: bearer("dueno"), payload: { name: "P" } })).json().id;
    const { video } = (
      await app.inject({
        method: "POST",
        url: "/videos",
        headers: bearer("dueno"),
        payload: { projectId: project, filename: "a.mp4", sizeBytes: MiB, mimeType: "video/mp4", durationSeconds: 60 },
      })
    ).json();
    expect((await app.inject({ method: "POST", url: `/admin/compare/${video.id}`, headers: bearer("dueno") })).statusCode).toBe(409);
  });
});
