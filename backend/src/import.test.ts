import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { FEATURES } from "@clipflow/shared";
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
      url: "https://www.tiktok.com/@ana/video/123#t=5",
      rightsConfirmed: true,
      clipDurationSeconds: 45,
      subtitleStyle: "classic",
    });
    expect(res.statusCode).toBe(201);
    const { video, job } = res.json();
    expect(video).toMatchObject({ status: "importing", originalFilename: "tiktok.com/@ana/video/123", sourceUrl: "https://www.tiktok.com/@ana/video/123" });
    expect(job).toMatchObject({ status: "queued", params: { clipDurationSeconds: 45, subtitleStyle: "classic" } });
    expect(ctx!.queue.sent).toEqual([job.id]);

    const [row] = await ctx!.database.db.select().from(schema.videos).where(eq(schema.videos.id, video.id));
    expect(row!.rightsConfirmedAt).toBeInstanceOf(Date);
    expect(row!.sizeBytes).toBe(0);
    expect(row!.s3Key).toMatch(/^originals\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/original\.mp4$/);
    // Ningún archivo se pidió a S3 desde la API: lo descarga el worker.
    expect(ctx!.storage.uploads.size).toBe(0);
  });

  it("con un tramo elegido (stream largo), guarda solo ese tramo; sin fin, hasta el máximo de 3 h", async () => {
    const projectId = await newProject("alice");
    const url = "https://kick.com/westcol/videos/01a0f415-f000-7000-8000-000000000000";
    const res = await importVideo("alice", { projectId, url, rightsConfirmed: true, startSeconds: 3600, endSeconds: 9000 });
    expect(res.statusCode).toBe(201);
    expect(res.json().video.sourceRange).toEqual({ startSeconds: 3600, endSeconds: 9000 });
    const [row] = await ctx!.database.db.select().from(schema.videos).where(eq(schema.videos.id, res.json().video.id));
    expect([row!.sourceStartSeconds, row!.sourceEndSeconds]).toEqual([3600, 9000]);

    const open = await importVideo("alice", { projectId, url, rightsConfirmed: true, startSeconds: 7200 });
    expect(open.json().video.sourceRange).toEqual({ startSeconds: 7200, endSeconds: 7200 + 3 * 3600 });
    // Sin tramo: el video entero.
    const whole = await importVideo("alice", { projectId, url, rightsConfirmed: true });
    expect(whole.json().video.sourceRange).toBeNull();
  });

  it("rechaza tramos al revés, muy cortos o más largos que el máximo", async () => {
    const projectId = await newProject("alice");
    const url = "https://kick.com/westcol/videos/01a0f415-f000-7000-8000-000000000000";
    const tryRange = (startSeconds: number, endSeconds: number) => importVideo("alice", { projectId, url, rightsConfirmed: true, startSeconds, endSeconds });
    expect((await tryRange(600, 300)).json().error).toMatchObject({ code: "invalid_range", message: "El final del tramo debe ser después del inicio." });
    expect((await tryRange(0, 10)).json().error.message).toBe("El tramo debe durar al menos 30 segundos.");
    expect((await tryRange(0, 4 * 3600)).json().error.message).toBe("El tramo puede durar como máximo 3 h.");
    expect(ctx!.queue.sent).toEqual([]);
  });

  it("sin confirmar los derechos no se importa", async () => {
    const projectId = await newProject("alice");
    for (const rightsConfirmed of [undefined, false]) {
      const res = await importVideo("alice", { projectId, url: "https://example.com/v.mp4", rightsConfirmed });
      expect(res.statusCode).toBe(400);
    }
    expect(ctx!.queue.sent).toEqual([]);
  });

  it("YouTube por ahora no se importa: responde con un mensaje claro y no crea nada", async () => {
    const projectId = await newProject("alice");
    const res = await importVideo("alice", { projectId, url: "https://youtu.be/abc", rightsConfirmed: true });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: "invalid_url", message: expect.stringContaining("no se pueden importar videos de YouTube") });
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

describe.runIf(!FEATURES.downloadOnly)("«Descargar solo el video» desactivado", () => {
  it("rechaza las importaciones de solo descarga sin crear nada", async () => {
    const projectId = await newProject("alice");
    const res = await importVideo("alice", { projectId, url: "https://www.tiktok.com/@ana/video/9", rightsConfirmed: true, downloadOnly: true });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("download_disabled");
    expect(ctx!.queue.sent).toEqual([]);
    expect(await ctx!.database.db.select().from(schema.videos)).toEqual([]);
  });

  it("no entrega el original de un video importado por enlace, pero sí crea clips con el enlace", async () => {
    const projectId = await newProject("alice");
    const res = await importVideo("alice", { projectId, url: "https://www.tiktok.com/@ana/video/9", rightsConfirmed: true });
    expect(res.statusCode).toBe(201);
    const { video } = res.json();
    await ctx!.database.db.update(schema.videos).set({ status: "ready", sizeBytes: 1234 }).where(eq(schema.videos.id, video.id));
    const dl = await app().inject({ method: "GET", url: `/videos/${video.id}/download`, headers: bearer("alice") });
    expect(dl.statusCode).toBe(403);
    expect(dl.json().error.code).toBe("download_disabled");
  });
});

describe.runIf(FEATURES.downloadOnly)("solo descargar el video (sin clips)", () => {
  it("crea un trabajo de solo descarga; luego se baja el original con su nombre y se pueden crear clips", async () => {
    const projectId = await newProject("alice");
    const res = await importVideo("alice", { projectId, url: "https://www.tiktok.com/@ana/video/9", rightsConfirmed: true, downloadOnly: true });
    expect(res.statusCode).toBe(201);
    const { video, job } = res.json();
    expect(job.params).toEqual({ downloadOnly: true });
    expect(ctx!.queue.sent).toEqual([job.id]);

    // Mientras se descarga, todavía no hay nada que bajar.
    const early = await app().inject({ method: "GET", url: `/videos/${video.id}/download`, headers: bearer("alice") });
    expect(early.statusCode).toBe(409);

    // El worker lo dejó listo (con su título como nombre).
    await ctx!.database.db
      .update(schema.videos)
      .set({ status: "ready", sizeBytes: 1234, originalFilename: "Canción de prueba: ¡hola! 🎵.mp4" })
      .where(eq(schema.videos.id, video.id));
    await ctx!.database.db.update(schema.processingJobs).set({ status: "completed" }).where(eq(schema.processingJobs.id, job.id));

    const dl = await app().inject({ method: "GET", url: `/videos/${video.id}/download`, headers: bearer("alice") });
    expect(dl.statusCode).toBe(200);
    expect(dl.json().url).toContain(`originals/`);
    expect(dl.json().url).toContain("Cancion-de-prueba-hola.mp4");
    // Otro usuario no puede bajarlo.
    expect((await app().inject({ method: "GET", url: `/videos/${video.id}/download`, headers: bearer("bob") })).statusCode).toBe(404);

    // Después puede crear clips del mismo video (otro trabajo, con sus opciones).
    const processed = await app().inject({
      method: "POST",
      url: `/videos/${video.id}/process`,
      headers: bearer("alice"),
      payload: { clipDurationSeconds: 30, subtitleStyle: "highlight" },
    });
    expect(processed.statusCode).toBe(201);
    expect(processed.json().params).toMatchObject({ clipDurationSeconds: 30 });
    expect(processed.json().id).not.toBe(job.id);
  });
});

describe.runIf(FEATURES.downloadOnly)("streams largos analizados con copia liviana", () => {
  it("no se ofrece la copia liviana para descargar y se explica cómo bajar el video completo", async () => {
    const projectId = await newProject("alice");
    const { video } = (await importVideo("alice", { projectId, url: "https://www.twitch.tv/videos/1", rightsConfirmed: true })).json();
    await ctx!.database.db
      .update(schema.videos)
      .set({ status: "ready", sizeBytes: 1234, probe: { clipflowAnalysisCopy: true } })
      .where(eq(schema.videos.id, video.id));
    const res = await app().inject({ method: "GET", url: `/videos/${video.id}/download`, headers: bearer("alice") });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: "analysis_copy", message: expect.stringContaining("Descargar solo el video") });
  });
});
