import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { DEFAULT_PRODUCT_CONFIG } from "@clipflow/shared";
import { claimJob, completeJob, schema } from "@clipflow/shared/db";
import { pipelineLabel } from "./admin.js";
import { bearer, closeTestApp, createTestApp, type TestContext } from "./test-helpers.js";

const MiB = 1024 * 1024;
let ctx: TestContext | undefined;
afterEach(async () => {
  await closeTestApp(ctx);
  ctx = undefined;
});

const PIPELINES = ["classic", "gemini:gemini-3.5-flash", "gemini:gemini-3.1-flash-lite"];

/** Video subido del administrador (sub "admin" → admin@example.com en los tests). */
async function adminVideo() {
  ctx = await createTestApp(DEFAULT_PRODUCT_CONFIG, { emails: ["admin@example.com"], comparePipelines: PIPELINES });
  const app = ctx.app;
  const project = (await app.inject({ method: "POST", url: "/projects", headers: bearer("admin"), payload: { name: "P" } })).json().id;
  const { video } = (
    await app.inject({
      method: "POST",
      url: "/videos",
      headers: bearer("admin"),
      payload: { projectId: project, filename: "stream.mp4", sizeBytes: 20 * MiB, mimeType: "video/mp4", durationSeconds: 600 },
    })
  ).json();
  ctx.storage.forceSize = 20 * MiB;
  await app.inject({
    method: "POST",
    url: `/videos/${video.id}/complete`,
    headers: bearer("admin"),
    payload: { parts: [1, 2].map((n) => ({ partNumber: n, etag: "e" })) },
  });
  return video.id as string;
}

describe("prueba lado a lado (solo administradores)", () => {
  it("un usuario normal no puede usarla", async () => {
    const videoId = await adminVideo();
    const app = ctx!.app;
    expect((await app.inject({ method: "GET", url: "/admin/me", headers: bearer("alice") })).json()).toEqual({ admin: false });
    expect((await app.inject({ method: "POST", url: `/admin/compare/${videoId}`, headers: bearer("alice") })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/admin/comparisons", headers: bearer("alice") })).statusCode).toBe(403);
  });

  it("procesa el mismo video con cada pipeline (cada uno con su copia del original) y compara clips y costo por minuto", async () => {
    const videoId = await adminVideo();
    const app = ctx!.app;
    const db = ctx!.database.db;
    expect((await app.inject({ method: "GET", url: "/admin/me", headers: bearer("admin") })).json()).toEqual({ admin: true });

    const res = await app.inject({ method: "POST", url: `/admin/compare/${videoId}`, headers: bearer("admin"), payload: { clipDurationSeconds: 30 } });
    expect(res.statusCode).toBe(201);
    const { comparisonId, variants } = res.json();
    expect(variants.map((v: { pipeline: string }) => v.pipeline)).toEqual(PIPELINES);

    const [source] = await db.select().from(schema.videos).where(eq(schema.videos.id, videoId));
    for (const v of variants) {
      const [copy] = await db.select().from(schema.videos).where(eq(schema.videos.id, v.videoId));
      expect(copy!.s3Key).not.toBe(source!.s3Key);
      expect(copy!.s3Key).toContain(`/${v.videoId}/`);
      expect(ctx!.storage.objects.has(copy!.s3Key)).toBe(true);
      const [job] = await db.select().from(schema.processingJobs).where(eq(schema.processingJobs.id, v.jobId));
      expect(job!.params).toMatchObject({ pipeline: v.pipeline, comparisonId, skipTranscriptCache: true, clipDurationSeconds: 30 });
    }
    const titles = await Promise.all(
      variants.map(async (v: { videoId: string }) => (await db.select().from(schema.videos).where(eq(schema.videos.id, v.videoId)))[0]!.originalFilename),
    );
    expect(titles).toEqual(["[Actual] stream.mp4", "[Gemini 3.5 Flash] stream.mp4", "[Gemini 3.1 Flash-Lite] stream.mp4"]);
    expect(ctx!.queue.sent).toEqual(expect.arrayContaining(variants.map((v: { jobId: string }) => v.jobId)));

    // El worker termina el de Gemini 3.5 Flash (y deja la duración real del video: 10 min).
    const gemini = variants[1];
    await db.update(schema.videos).set({ durationSeconds: 600, status: "ready" }).where(eq(schema.videos.id, gemini.videoId));
    await claimJob(db, gemini.jobId, "w");
    await completeJob(db, gemini.jobId, "w", {
      clipCount: 1,
      ai: "used",
      providers: { transcription: "groq:whisper-large-v3", analysis: "gemini:gemini-3.5-flash" },
      costs: { transcriptionUsd: 0.02, textUsd: 0.1, visionUsd: 0, computeUsd: 0.03, totalUsd: 0.15 },
    });
    await db.insert(schema.clips).values({
      userId: (await db.select().from(schema.videos).where(eq(schema.videos.id, gemini.videoId)))[0]!.userId,
      videoId: gemini.videoId,
      jobId: gemini.jobId,
      title: "El gancho",
      startSeconds: 10,
      endSeconds: 40,
      score: 0.9,
      aiReason: "Dato sorprendente.",
      s3Key: "clips/x/0.mp4",
    });

    const list = (await app.inject({ method: "GET", url: "/admin/comparisons", headers: bearer("admin") })).json();
    expect(list.comparisons).toHaveLength(1);
    const v = list.comparisons[0].variants.find((x: { pipeline: string }) => x.pipeline === "gemini:gemini-3.5-flash");
    expect(v).toMatchObject({ label: "Gemini 3.5 Flash", status: "completed", clipCount: 1 });
    expect(v.totalUsdPerMinute).toBeCloseTo(0.015); // 0,15 USD / 10 min
    expect(v.aiUsdPerMinute).toBeCloseTo(0.012);
    expect(v.clips[0]).toMatchObject({ title: "El gancho", reason: "Dato sorprendente." });
    expect(list.comparisons[0].video).toBe("stream.mp4");
  });

  it("nombres cortos de los pipelines", () => {
    expect(pipelineLabel("classic")).toBe("Actual");
    expect(pipelineLabel("gemini:gemini-3.5-flash")).toBe("Gemini 3.5 Flash");
    expect(pipelineLabel("gemini")).toBe("Gemini");
  });
});
