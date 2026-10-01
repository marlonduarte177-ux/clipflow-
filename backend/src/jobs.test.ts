import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { fullTranscriptKey } from "@clipflow/shared";
import { claimJob, completeJob, failJob, schema } from "@clipflow/shared/db";
import { bearer, closeTestApp, createTestApp, type TestContext } from "./test-helpers.js";

const MiB = 1024 * 1024;
let ctx: TestContext | undefined;
beforeEach(async () => {
  ctx = await createTestApp();
});
afterEach(async () => {
  await closeTestApp(ctx);
  ctx = undefined;
});
const app = () => ctx!.app;
const db = () => ctx!.database.db;

/** Sube un video completo (con S3 falso) y devuelve la respuesta de "complete". */
async function uploadedVideo(sub: string) {
  const project = (await app().inject({ method: "POST", url: "/projects", headers: bearer(sub), payload: { name: "P" } })).json();
  const { video } = (
    await app().inject({
      method: "POST",
      url: "/videos",
      headers: bearer(sub),
      payload: { projectId: project.id, filename: "a.mp4", sizeBytes: 20 * MiB, mimeType: "video/mp4" },
    })
  ).json();
  ctx!.storage.forceSize = 20 * MiB;
  const complete = (options: Record<string, unknown> = {}) =>
    app().inject({
      method: "POST",
      url: `/videos/${video.id}/complete`,
      headers: bearer(sub),
      payload: { parts: [1, 2].map((n) => ({ partNumber: n, etag: "e" })), ...options },
    });
  return { video, complete };
}

describe("trabajos de procesamiento", () => {
  it("terminar la subida crea UN trabajo y lo envía a la cola una sola vez", async () => {
    const { video, complete } = await uploadedVideo("alice");
    const first = (await complete()).json();
    expect(first.job).toMatchObject({
      status: "queued",
      progress: 0,
      params: { clipDurationSeconds: 30, subtitleStyle: "highlight" }, // valores por defecto
    });
    expect(ctx!.queue.sent).toEqual([first.job.id]);
    // Se pidió encender procesadores al empezar la subida y al encolar (sin esperar a las métricas).
    await new Promise((r) => setTimeout(r, 50));
    expect(ctx!.launcher.requests.length).toBeGreaterThanOrEqual(2);
    expect(ctx!.launcher.requests.at(-1)).toBe(1); // 1 trabajo en cola → 1 procesador

    await complete(); // repetir no duplica
    expect(ctx!.queue.sent).toHaveLength(1);
    const jobs = (await app().inject({ method: "GET", url: `/jobs?videoId=${video.id}`, headers: bearer("alice") })).json();
    expect(jobs.jobs).toHaveLength(1);
  });

  it("usa la duración y el estilo de subtítulos elegidos antes de procesar", async () => {
    const { complete } = await uploadedVideo("alice");
    const done = (await complete({ clipDurationSeconds: 60, subtitleStyle: "none" })).json();
    expect(done.job.params).toEqual({ clipDurationSeconds: 60, subtitleStyle: "none" });
  });

  it("rechaza una duración no permitida sin terminar la subida ni crear el trabajo", async () => {
    const { video, complete } = await uploadedVideo("alice");
    const res = await complete({ clipDurationSeconds: 37 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_duration");
    expect(ctx!.queue.sent).toEqual([]);
    const after = (await app().inject({ method: "GET", url: `/videos/${video.id}`, headers: bearer("alice") })).json();
    expect(after.status).toBe("pending_upload");
    expect((await complete({ subtitleStyle: "neon" })).statusCode).toBe(400);
  });

  it("si SQS falla, el trabajo no se pierde y puede reenviarse", async () => {
    const { complete } = await uploadedVideo("alice");
    ctx!.queue.failNext = true;
    const { job } = (await complete()).json();
    expect(job.status).toBe("queued");
    expect(ctx!.queue.sent).toEqual([]);

    // Recién creado: aún no se considera atascado.
    const early = await app().inject({ method: "POST", url: `/jobs/${job.id}/retry`, headers: bearer("alice") });
    expect(early.statusCode).toBe(409);

    await db()
      .update(schema.processingJobs)
      .set({ queuedAt: sql`now() - interval '10 minutes'` })
      .where(eq(schema.processingJobs.id, job.id));
    const retry = await app().inject({ method: "POST", url: `/jobs/${job.id}/retry`, headers: bearer("alice") });
    expect(retry.statusCode).toBe(200);
    expect(ctx!.queue.sent).toEqual([job.id]);
  });

  it("cancelar un trabajo en cola lo cancela y luego se puede reintentar", async () => {
    const { complete } = await uploadedVideo("alice");
    const { job } = (await complete()).json();
    const cancelled = await app().inject({ method: "POST", url: `/jobs/${job.id}/cancel`, headers: bearer("alice") });
    expect(cancelled.json().status).toBe("cancelled");
    const again = await app().inject({ method: "POST", url: `/jobs/${job.id}/cancel`, headers: bearer("alice") });
    expect(again.statusCode).toBe(409);
    const retry = await app().inject({ method: "POST", url: `/jobs/${job.id}/retry`, headers: bearer("alice") });
    expect(retry.json()).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("un trabajo fallido muestra el mensaje y se puede reintentar", async () => {
    const { complete } = await uploadedVideo("alice");
    const { job } = (await complete()).json();
    await claimJob(db(), job.id, "w");
    await failJob(db(), job.id, "w", { code: "invalid_video", message: "El archivo no es un video válido.", retryable: false });
    const got = (await app().inject({ method: "GET", url: `/jobs/${job.id}`, headers: bearer("alice") })).json();
    expect(got).toMatchObject({ status: "failed", errorMessage: "El archivo no es un video válido." });
    const retry = await app().inject({ method: "POST", url: `/jobs/${job.id}/retry`, headers: bearer("alice") });
    expect(retry.statusCode).toBe(200);
  });
});

describe("clips", () => {
  async function videoWithClip(sub: string) {
    const { video, complete } = await uploadedVideo(sub);
    const { job } = (await complete()).json();
    const [user] = await db().select().from(schema.users).where(eq(schema.users.cognitoSub, sub));
    const [clip] = await db()
      .insert(schema.clips)
      .values({
        userId: user!.id,
        videoId: video.id,
        jobId: job.id,
        startSeconds: 10,
        endSeconds: 40,
        score: 0.8,
        s3Key: `clips/${user!.id}/c/clip.mp4`,
        thumbnailS3Key: `thumbnails/${user!.id}/c/thumb.jpg`,
      })
      .returning();
    await db().insert(schema.subtitles).values([
      { userId: user!.id, videoId: video.id, clipId: clip!.id, format: "vtt" as const, s3Key: `subtitles/${user!.id}/c/0.vtt` },
      { userId: user!.id, videoId: video.id, clipId: clip!.id, format: "srt" as const, s3Key: `subtitles/${user!.id}/c/0.srt` },
    ]);
    return { video, clip: clip!, job, userId: user!.id };
  }

  it("la lista de videos trae la miniatura del mejor clip y cuántos clips hay (sin descartados)", async () => {
    const { video, job, userId } = await videoWithClip("alice");
    await db().insert(schema.clips).values([
      { userId, videoId: video.id, jobId: job.id, startSeconds: 50, endSeconds: 80, score: 0.95, s3Key: "clips/x/best.mp4", thumbnailS3Key: "thumbnails/x/best.jpg" },
      { userId, videoId: video.id, jobId: job.id, startSeconds: 90, endSeconds: 120, score: 0.99, status: "discarded", thumbnailS3Key: "thumbnails/x/no.jpg" },
    ]);
    const list = (await app().inject({ method: "GET", url: "/videos", headers: bearer("alice") })).json();
    expect(list.videos[0]).toMatchObject({ id: video.id, clipCount: 2 });
    expect(list.videos[0].thumbnailUrl).toContain("best.jpg");
    const one = (await app().inject({ method: "GET", url: `/videos/${video.id}`, headers: bearer("alice") })).json();
    expect(one).toMatchObject({ clipCount: 2 });
    // Otro usuario no ve nada de esto.
    const bob = (await app().inject({ method: "GET", url: "/videos", headers: bearer("bob") })).json();
    expect(bob.videos).toEqual([]);
  });

  it("la transcripción completa aparece solo si hubo IA y el archivo existe", async () => {
    const { video, job, userId } = await videoWithClip("alice");
    const transcript = async () =>
      (await app().inject({ method: "GET", url: `/videos/${video.id}/clips`, headers: bearer("alice") })).json().transcript;
    expect(await transcript()).toBeNull(); // todavía no terminó

    await claimJob(db(), job.id, "w");
    await completeJob(db(), job.id, "w", { clipCount: 1, ai: "used", language: "spanish" });
    expect(await transcript()).toBeNull(); // procesado antes de existir el archivo

    ctx!.storage.objects.set(fullTranscriptKey(userId, job.id), 1);
    expect(await transcript()).toEqual({ vttUrl: expect.stringContaining("full.vtt"), language: "spanish" });

    await db().update(schema.processingJobs).set({ result: { clipCount: 1, ai: "no_speech" } }).where(eq(schema.processingJobs.id, job.id));
    expect(await transcript()).toBeNull();
  });

  it("lista los clips con URLs temporales, y se pueden aprobar, descartar y descargar", async () => {
    const { video, clip } = await videoWithClip("alice");
    const list = (await app().inject({ method: "GET", url: `/videos/${video.id}/clips`, headers: bearer("alice") })).json();
    expect(list.clips).toHaveLength(1);
    expect(list.clips[0]).toMatchObject({ score: 0.8, startSeconds: 10, endSeconds: 40, status: "generated" });
    expect(list.clips[0].videoUrl).toContain("expires=900");
    expect(list.clips[0].thumbnailUrl).toContain("thumb.jpg");
    expect(list.clips[0].subtitlesVttUrl).toContain("0.vtt");
    expect(list.clips[0].subtitlesSrtUrl).toContain("download=clipflow-10s.srt");

    const approved = await app().inject({ method: "PATCH", url: `/clips/${clip.id}`, headers: bearer("alice"), payload: { status: "approved" } });
    expect(approved.json().status).toBe("approved");
    const bad = await app().inject({ method: "PATCH", url: `/clips/${clip.id}`, headers: bearer("alice"), payload: { status: "hacked" } });
    expect(bad.statusCode).toBe(400);

    const download = (await app().inject({ method: "GET", url: `/clips/${clip.id}/download`, headers: bearer("alice") })).json();
    expect(download.url).toContain("download=clipflow-10s-40s.mp4");
  });

  it("otro usuario no puede ver ni modificar clips o trabajos ajenos", async () => {
    const { video, clip } = await videoWithClip("alice");
    const asBob = bearer("bob");
    const jobs = (await app().inject({ method: "GET", url: `/jobs?videoId=${video.id}`, headers: bearer("alice") })).json();
    const jobId = jobs.jobs[0].id;
    const responses = await Promise.all([
      app().inject({ method: "GET", url: `/videos/${video.id}/clips`, headers: asBob }),
      app().inject({ method: "PATCH", url: `/clips/${clip.id}`, headers: asBob, payload: { status: "discarded" } }),
      app().inject({ method: "GET", url: `/clips/${clip.id}/download`, headers: asBob }),
      app().inject({ method: "GET", url: `/jobs/${jobId}`, headers: asBob }),
      app().inject({ method: "POST", url: `/jobs/${jobId}/cancel`, headers: asBob }),
      app().inject({ method: "POST", url: `/jobs/${jobId}/retry`, headers: asBob }),
    ]);
    for (const res of responses) expect(res.statusCode).toBe(404);
    const bobJobs = (await app().inject({ method: "GET", url: "/jobs", headers: asBob })).json();
    expect(bobJobs.jobs).toEqual([]);
    const [still] = await db().select().from(schema.clips).where(eq(schema.clips.id, clip.id));
    expect(still!.status).toBe("generated");
  });
});
