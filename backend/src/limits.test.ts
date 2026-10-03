import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PRODUCT_CONFIG } from "@clipflow/shared";
import { bearer, closeTestApp, createTestApp, type TestContext } from "./test-helpers.js";

const MiB = 1024 * 1024;
let ctx: TestContext | undefined;
afterEach(async () => {
  await closeTestApp(ctx);
  ctx = undefined;
});

async function start(daily: { maxJobs: number; maxVideoMinutes: number }) {
  ctx = await createTestApp({ ...DEFAULT_PRODUCT_CONFIG, upload: { ...DEFAULT_PRODUCT_CONFIG.upload, maxPendingUploads: 10 }, daily });
  const projectId = (await ctx.app.inject({ method: "POST", url: "/projects", headers: bearer("alice"), payload: { name: "P" } })).json().id;
  const importLink = (n: number, sub = "alice", project = projectId) =>
    ctx!.app.inject({
      method: "POST",
      url: "/videos/import",
      headers: bearer(sub),
      payload: { projectId: project, url: `https://example.com/${n}.mp4`, rightsConfirmed: true },
    });
  const upload = (durationSeconds: number) =>
    ctx!.app.inject({
      method: "POST",
      url: "/videos",
      headers: bearer("alice"),
      payload: { projectId, filename: "a.mp4", sizeBytes: 10 * MiB, mimeType: "video/mp4", durationSeconds },
    });
  return { projectId, importLink, upload };
}

describe("tope diario por usuario", () => {
  it("cuenta los videos mandados a crear clips en 24 h; otro usuario no se ve afectado", async () => {
    const { importLink } = await start({ maxJobs: 2, maxVideoMinutes: 600 });
    expect((await importLink(1)).statusCode).toBe(201);
    expect((await importLink(2)).statusCode).toBe(201);
    const third = await importLink(3);
    expect(third.statusCode).toBe(429);
    expect(third.json().error).toMatchObject({ code: "daily_limit", message: expect.stringContaining("2 videos por día") });

    const bobProject = (await ctx!.app.inject({ method: "POST", url: "/projects", headers: bearer("bob"), payload: { name: "B" } })).json().id;
    expect((await importLink(4, "bob", bobProject)).statusCode).toBe(201);
  });

  it("suma los minutos de video: no deja subir uno que pase el tope", async () => {
    const { upload } = await start({ maxJobs: 20, maxVideoMinutes: 60 });
    // Antes de subir se conoce la duración: 70 min no entran en 60.
    const res = await upload(70 * 60);
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("daily_limit");
    expect((await upload(30 * 60)).statusCode).toBe(201);
  });
});
