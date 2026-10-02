import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { claimJob, schema } from "@clipflow/shared/db";
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
const files = () => [...ctx!.storage.objects.keys()].sort();

async function newProject(sub: string) {
  return (await app().inject({ method: "POST", url: "/projects", headers: bearer(sub), payload: { name: "P" } })).json().id as string;
}

/** Video subido y procesado (clip, miniatura y subtítulos en el S3 falso). */
async function processedVideo(sub: string, projectId?: string) {
  const project = projectId ?? (await newProject(sub));
  const { video } = (
    await app().inject({
      method: "POST",
      url: "/videos",
      headers: bearer(sub),
      payload: { projectId: project, filename: "a.mp4", sizeBytes: 20 * MiB, mimeType: "video/mp4" },
    })
  ).json();
  ctx!.storage.forceSize = 20 * MiB;
  const { job } = (
    await app().inject({
      method: "POST",
      url: `/videos/${video.id}/complete`,
      headers: bearer(sub),
      payload: { parts: [1, 2].map((n) => ({ partNumber: n, etag: "e" })) },
    })
  ).json();
  const [user] = await db().select().from(schema.users).where(eq(schema.users.cognitoSub, sub));
  const userId = user!.id;
  const keys = {
    clip: `clips/${userId}/${job.id}/0.mp4`,
    thumb: `thumbnails/${userId}/${job.id}/0.jpg`,
    vtt: `subtitles/${userId}/${job.id}/0.vtt`,
    // Transcripción guardada del video (para no volver a pagarla): se borra con el video.
    transcript: `transcripts/${userId}/${video.id}/openai-whisper-1.json`,
    // Archivo huérfano de un reintento anterior: también debe borrarse.
    old: `clips/${userId}/${job.id}/7.mp4`,
  };
  Object.values(keys).forEach((k) => ctx!.storage.objects.set(k, 1));
  const [clip] = await db()
    .insert(schema.clips)
    .values({ userId, videoId: video.id, jobId: job.id, startSeconds: 0, endSeconds: 30, score: 0.9, s3Key: keys.clip, thumbnailS3Key: keys.thumb })
    .returning();
  await db().insert(schema.subtitles).values({ userId, videoId: video.id, clipId: clip!.id, format: "vtt" as const, s3Key: keys.vtt });
  return { video, job, project, userId };
}

describe("eliminar videos", () => {
  it("borra el video, su procesamiento, sus clips y TODOS sus archivos en S3", async () => {
    const keep = await processedVideo("alice");
    const target = await processedVideo("alice");
    const before = files();
    expect(before.filter((k) => k.includes(target.video.id) || k.includes(target.job.id))).toHaveLength(6);

    const res = await app().inject({ method: "DELETE", url: `/videos/${target.video.id}`, headers: bearer("alice") });
    expect(res.statusCode).toBe(204);

    // Ningún archivo del video borrado queda en S3; los del otro video siguen.
    expect(files().filter((k) => k.includes(target.video.id) || k.includes(target.job.id))).toEqual([]);
    expect(files().filter((k) => k.includes(keep.video.id) || k.includes(keep.job.id))).toHaveLength(6);

    expect((await app().inject({ method: "GET", url: `/videos/${target.video.id}`, headers: bearer("alice") })).statusCode).toBe(404);
    const count = async (table: typeof schema.clips | typeof schema.processingJobs | typeof schema.subtitles) =>
      (await db().select().from(table).where(eq(table.videoId, target.video.id))).length;
    expect(await count(schema.processingJobs)).toBe(0);
    expect(await count(schema.clips)).toBe(0);
    expect(await count(schema.subtitles)).toBe(0);

    // El historial de consumo se conserva (sin enlace al video).
    const usage = await db().select().from(schema.usage).where(eq(schema.usage.userId, target.userId));
    expect(usage).toHaveLength(2);
    expect(usage.filter((u) => u.videoId === null)).toHaveLength(1);

    // Repetir responde 404: ya no existe.
    expect((await app().inject({ method: "DELETE", url: `/videos/${target.video.id}`, headers: bearer("alice") })).statusCode).toBe(404);
  });

  it("otro usuario no puede eliminarlo (404 sin revelar que existe) y no se borra nada", async () => {
    const { video } = await processedVideo("alice");
    const before = files();
    const res = await app().inject({ method: "DELETE", url: `/videos/${video.id}`, headers: bearer("bob") });
    expect(res.statusCode).toBe(404);
    expect(files()).toEqual(before);
    expect((await app().inject({ method: "GET", url: `/videos/${video.id}`, headers: bearer("alice") })).statusCode).toBe(200);
  });

  it("no se elimina mientras se procesa; sí si el procesamiento quedó colgado", async () => {
    const { video, job } = await processedVideo("alice");
    await claimJob(db(), job.id, "worker-1");

    const busy = await app().inject({ method: "DELETE", url: `/videos/${video.id}`, headers: bearer("alice") });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error.code).toBe("video_processing");
    expect((await app().inject({ method: "GET", url: `/videos/${video.id}`, headers: bearer("alice") })).statusCode).toBe(200);

    // El worker murió hace 10 min (sin latido): ya se puede eliminar.
    await db()
      .update(schema.processingJobs)
      .set({ heartbeatAt: sql`now() - interval '10 minutes'` })
      .where(eq(schema.processingJobs.id, job.id));
    expect((await app().inject({ method: "DELETE", url: `/videos/${video.id}`, headers: bearer("alice") })).statusCode).toBe(204);
  });

  it("una subida sin terminar se cancela en S3 al eliminarla", async () => {
    const projectId = await newProject("alice");
    const { video } = (
      await app().inject({
        method: "POST",
        url: "/videos",
        headers: bearer("alice"),
        payload: { projectId, filename: "a.mp4", sizeBytes: 20 * MiB, mimeType: "video/mp4" },
      })
    ).json();
    expect((await app().inject({ method: "DELETE", url: `/videos/${video.id}`, headers: bearer("alice") })).statusCode).toBe(204);
    expect([...ctx!.storage.uploads.values()].every((u) => u.aborted)).toBe(true);
  });
});

describe("eliminar proyectos", () => {
  it("borra también los archivos en S3 de todos sus videos", async () => {
    const projectId = await newProject("alice");
    await processedVideo("alice", projectId);
    await processedVideo("alice", projectId);
    const other = await processedVideo("alice");
    const res = await app().inject({ method: "DELETE", url: `/projects/${projectId}`, headers: bearer("alice") });
    expect(res.statusCode).toBe(204);
    // Solo quedan los archivos del video de otro proyecto.
    expect(files().every((k) => k.includes(other.video.id) || k.includes(other.job.id))).toBe(true);
    expect(files()).toHaveLength(6);
  });

  it("no se borra si uno de sus videos se está procesando", async () => {
    const { project, job } = await processedVideo("alice");
    await claimJob(db(), job.id, "worker-1");
    const res = await app().inject({ method: "DELETE", url: `/projects/${project}`, headers: bearer("alice") });
    expect(res.statusCode).toBe(409);
    expect((await app().inject({ method: "GET", url: `/projects/${project}`, headers: bearer("alice") })).statusCode).toBe(200);
  });
});
