import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@clipflow/shared/db";
import { bearer, closeTestApp, createTestApp, type TestContext } from "./test-helpers.js";

const MiB = 1024 * 1024;
let ctx: TestContext | undefined;
beforeEach(async () => {
  // «admin@example.com» es correo de administrador: solo él ve y usa el editor.
  ctx = await createTestApp(undefined, { BILLING_ENABLED: false, POLAR_SERVER: "sandbox", BILLING_FREE_EMAILS: "admin@example.com" });
});
afterEach(async () => {
  await closeTestApp(ctx);
  ctx = undefined;
});
const app = () => ctx!.app;
const db = () => ctx!.database.db;

/** Sube un video, lo completa (crea su trabajo) y le agrega un clip. */
async function videoWithClip(sub: string, clip: Partial<typeof schema.clips.$inferInsert> = {}) {
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
  const { job } = (
    await app().inject({
      method: "POST",
      url: `/videos/${video.id}/complete`,
      headers: bearer(sub),
      payload: { parts: [1, 2].map((n) => ({ partNumber: n, etag: "e" })) },
    })
  ).json();
  const [user] = await db().select().from(schema.users).where(eq(schema.users.cognitoSub, sub));
  const [row] = await db()
    .insert(schema.clips)
    .values({ userId: user!.id, videoId: video.id, jobId: job.id, startSeconds: 10, endSeconds: 40, s3Key: `clips/${user!.id}/c/0.mp4`, ...clip })
    .returning();
  return { video, job, clip: row!, userId: user!.id };
}

describe("editor de clips (solo administradores)", () => {
  it("los trabajos de un administrador guardan los clips listos para editar; los del público, no", async () => {
    const admin = await videoWithClip("admin");
    expect(admin.job.params).toMatchObject({ editable: true });
    const alice = await videoWithClip("alice");
    expect(alice.job.params.editable).toBeUndefined();
  });

  it("el público no ve el editor ni puede usarlo", async () => {
    const { video, clip } = await videoWithClip("alice", { cleanS3Key: "clips/x/0-clean.mp4" });
    const list = (await app().inject({ method: "GET", url: `/videos/${video.id}/clips`, headers: bearer("alice") })).json();
    expect(list.clips[0]).not.toHaveProperty("editable");
    expect(list.clips[0]).not.toHaveProperty("editedVideoUrl");
    const res = await app().inject({
      method: "POST",
      url: `/videos/${video.id}/edit`,
      headers: bearer("alice"),
      payload: { clipIds: [clip.id], mode: "viral" },
    });
    expect(res.statusCode).toBe(403);
    expect(ctx!.queue.sent).toHaveLength(1); // solo el procesamiento del video
  });

  it("modo viral: crea UN trabajo de edición con los clips; uno a la vez; no se mezcla con el procesamiento", async () => {
    const { video, clip, job, userId } = await videoWithClip("admin", { cleanS3Key: "clips/x/0-clean.mp4" });
    const [other] = await db()
      .insert(schema.clips)
      .values({ userId, videoId: video.id, jobId: job.id, startSeconds: 50, endSeconds: 80, cleanS3Key: "clips/x/1-clean.mp4" })
      .returning();
    const list = (await app().inject({ method: "GET", url: `/videos/${video.id}/clips`, headers: bearer("admin") })).json();
    expect(list.clips[0]).toMatchObject({ editable: true, editedVideoUrl: null, edit: null });

    const res = await app().inject({
      method: "POST",
      url: `/videos/${video.id}/edit`,
      headers: bearer("admin"),
      payload: { clipIds: [clip.id, other!.id], mode: "viral", music: false },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ type: "render_clip", status: "queued", params: { clipIds: [clip.id, other!.id], edit: { mode: "viral", music: false } } });
    expect(ctx!.queue.sent).toContain(res.json().id);

    const again = await app().inject({ method: "POST", url: `/videos/${video.id}/edit`, headers: bearer("admin"), payload: { clipIds: [clip.id], mode: "viral" } });
    expect(again.json().error.code).toBe("already_editing");

    // La página del video sigue viendo su procesamiento; la edición se pide aparte.
    const jobs = (await app().inject({ method: "GET", url: `/jobs?videoId=${video.id}`, headers: bearer("admin") })).json().jobs;
    expect(jobs.map((j: { type: string }) => j.type)).toEqual(["analyze_video"]);
    const edits = (await app().inject({ method: "GET", url: `/jobs?videoId=${video.id}&type=render_clip`, headers: bearer("admin") })).json().jobs;
    expect(edits).toHaveLength(1);

    // Terminada: la versión editada se ve y se descarga aparte del clip original.
    await db().update(schema.clips).set({ editedS3Key: "clips/x/edit/0.mp4", edit: { mode: "viral", music: true, at: "2026-10-20T00:00:00Z", jobId: res.json().id } }).where(eq(schema.clips.id, clip.id));
    const after = (await app().inject({ method: "GET", url: `/videos/${video.id}/clips`, headers: bearer("admin") })).json();
    const edited = after.clips.find((c: { id: string }) => c.id === clip.id);
    expect(edited.editedVideoUrl).toContain("clips/x/edit/0.mp4");
    expect(edited.edit).toMatchObject({ mode: "viral" });
    const dl = (await app().inject({ method: "GET", url: `/clips/${clip.id}/download?edited=1`, headers: bearer("admin") })).json();
    expect(dl.url).toContain("clips/x/edit/0.mp4");
    expect(dl.url).toContain("viral");
  });

  it("un clip de un enlace sin copia limpia (original borrado) no se puede editar y lo explica", async () => {
    const { video, clip } = await videoWithClip("admin");
    await db().update(schema.videos).set({ sourceUrl: "https://kick.com/a/videos/1", probe: { clipflowOriginalDeleted: true } }).where(eq(schema.videos.id, video.id));
    const list = (await app().inject({ method: "GET", url: `/videos/${video.id}/clips`, headers: bearer("admin") })).json();
    expect(list.clips[0]).toMatchObject({ editable: false });
    const res = await app().inject({ method: "POST", url: `/videos/${video.id}/edit`, headers: bearer("admin"), payload: { clipIds: [clip.id], mode: "viral" } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("not_editable");
  });
});
