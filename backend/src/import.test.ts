import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@clipflow/shared/db";
import { bearer, closeTestApp, createTestApp, type TestContext } from "./test-helpers.js";

let ctx: TestContext | undefined;
beforeEach(async () => {
  ctx = await createTestApp();
});
afterEach(async () => {
  await closeTestApp(ctx);
  ctx = undefined;
});
const app = () => ctx!.app;

async function newProject(sub: string) {
  return (await app().inject({ method: "POST", url: "/projects", headers: bearer(sub), payload: { name: "P" } })).json().id as string;
}
const importVideo = (sub: string, payload: Record<string, unknown>) =>
  app().inject({ method: "POST", url: "/videos/import", headers: bearer(sub), payload });

describe("importar videos por enlace", () => {
  it("crea el video 'descargando' y su trabajo con las opciones elegidas; guarda el enlace y la confirmación", async () => {
    const projectId = await newProject("alice");
    const res = await importVideo("alice", {
      projectId,
      url: "https://www.youtube.com/watch?v=abc123#t=5",
      rightsConfirmed: true,
      clipDurationSeconds: 45,
      subtitleStyle: "classic",
    });
    expect(res.statusCode).toBe(201);
    const { video, job } = res.json();
    expect(video).toMatchObject({ status: "importing", originalFilename: "youtube.com/watch", sourceUrl: "https://www.youtube.com/watch?v=abc123" });
    expect(job).toMatchObject({ status: "queued", params: { clipDurationSeconds: 45, subtitleStyle: "classic" } });
    expect(ctx!.queue.sent).toEqual([job.id]);

    const [row] = await ctx!.database.db.select().from(schema.videos).where(eq(schema.videos.id, video.id));
    expect(row!.rightsConfirmedAt).toBeInstanceOf(Date);
    expect(row!.sizeBytes).toBe(0);
    expect(row!.s3Key).toMatch(/^originals\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/original\.mp4$/);
    // Ningún archivo se pidió a S3 desde la API: lo descarga el worker.
    expect(ctx!.storage.uploads.size).toBe(0);
  });

  it("sin confirmar los derechos no se importa", async () => {
    const projectId = await newProject("alice");
    for (const rightsConfirmed of [undefined, false]) {
      const res = await importVideo("alice", { projectId, url: "https://example.com/v.mp4", rightsConfirmed });
      expect(res.statusCode).toBe(400);
    }
    expect(ctx!.queue.sent).toEqual([]);
  });

  it("rechaza enlaces inválidos o a direcciones internas", async () => {
    const projectId = await newProject("alice");
    for (const url of ["hola", "ftp://example.com/v.mp4", "http://169.254.170.2/v2/credentials", "http://localhost/x"]) {
      const res = await importVideo("alice", { projectId, url, rightsConfirmed: true });
      expect(res.statusCode, url).toBe(400);
      expect(res.json().error.code, url).toBe("invalid_url");
    }
  });

  it("no se puede importar en el proyecto de otro usuario", async () => {
    const projectId = await newProject("alice");
    const res = await importVideo("bob", { projectId, url: "https://example.com/v.mp4", rightsConfirmed: true });
    expect(res.statusCode).toBe(404);
  });

  it("limita cuántos videos se descargan a la vez", async () => {
    const projectId = await newProject("alice");
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await importVideo("alice", { projectId, url: `https://example.com/${i}.mp4`, rightsConfirmed: true })).statusCode);
    }
    expect(statuses).toEqual([201, 201, 201, 429]);
  });
});
