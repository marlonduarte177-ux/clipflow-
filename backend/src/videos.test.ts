import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PRODUCT_CONFIG } from "@clipflow/shared";
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

async function newProject(sub: string) {
  const res = await app().inject({ method: "POST", url: "/projects", headers: bearer(sub), payload: { name: "P" } });
  return res.json().id as string;
}

async function startUpload(sub: string, overrides: Record<string, unknown> = {}) {
  const projectId = (overrides.projectId as string | undefined) ?? (await newProject(sub));
  return app().inject({
    method: "POST",
    url: "/videos",
    headers: bearer(sub),
    payload: { projectId, filename: "episodio 1.mp4", sizeBytes: 40 * MiB, mimeType: "video/mp4", durationSeconds: 600, ...overrides },
  });
}

describe("subida de videos: flujo completo", () => {
  it("crea, firma partes, completa y registra el video", async () => {
    const created = await startUpload("alice");
    expect(created.statusCode).toBe(201);
    const { video, upload } = created.json();
    expect(video).toMatchObject({ status: "pending_upload", originalFilename: "episodio 1.mp4", durationSeconds: 600 });
    expect(upload).toEqual({ partSizeBytes: 16 * MiB, partCount: 3 });

    // La ruta en S3 la decide el servidor y no usa el nombre del archivo.
    const [s3Upload] = [...ctx!.storage.uploads.values()];
    expect(s3Upload!.key).toMatch(/^originals\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/original\.mp4$/);
    expect(s3Upload!.key).not.toContain("episodio");

    const urls = await app().inject({
      method: "POST",
      url: `/videos/${video.id}/upload-parts`,
      headers: bearer("alice"),
      payload: { partNumbers: [1, 2, 3] },
    });
    expect(urls.statusCode).toBe(200);
    expect(urls.json().urls).toHaveLength(3);
    expect(urls.json().expiresInSeconds).toBe(900);

    ctx!.storage.forceSize = 40 * MiB;
    const done = await app().inject({
      method: "POST",
      url: `/videos/${video.id}/complete`,
      headers: bearer("alice"),
      payload: { parts: [3, 1, 2].map((n) => ({ partNumber: n, etag: `"etag-${n}"` })) },
    });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ status: "uploaded" });
    expect(done.json().uploadedAt).not.toBeNull();

    // Repetir "complete" no rompe nada.
    const again = await app().inject({
      method: "POST",
      url: `/videos/${video.id}/complete`,
      headers: bearer("alice"),
      payload: { parts: [{ partNumber: 1, etag: "x" }] },
    });
    expect(again.json().status).toBe("uploaded");

    const list = await app().inject({ method: "GET", url: "/videos", headers: bearer("alice") });
    expect(list.json().videos).toHaveLength(1);
  });

  it("rechaza el video si el tamaño real en S3 no coincide", async () => {
    const { video } = (await startUpload("alice")).json();
    ctx!.storage.forceSize = 1234;
    const res = await app().inject({
      method: "POST",
      url: `/videos/${video.id}/complete`,
      headers: bearer("alice"),
      payload: { parts: [1, 2, 3].map((n) => ({ partNumber: n, etag: "e" })) },
    });
    expect(res.statusCode).toBe(422);
    const got = await app().inject({ method: "GET", url: `/videos/${video.id}`, headers: bearer("alice") });
    expect(got.json().status).toBe("rejected");
    expect(ctx!.storage.objects.size).toBe(0); // el archivo se borró
  });

  it("no completa si faltan partes", async () => {
    const { video } = (await startUpload("alice")).json();
    const res = await app().inject({
      method: "POST",
      url: `/videos/${video.id}/complete`,
      headers: bearer("alice"),
      payload: { parts: [{ partNumber: 1, etag: "e" }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("incomplete_upload");
  });

  it("cancelar aborta la subida en S3 y borra el registro", async () => {
    const { video } = (await startUpload("alice")).json();
    const res = await app().inject({ method: "POST", url: `/videos/${video.id}/abort`, headers: bearer("alice") });
    expect(res.statusCode).toBe(204);
    expect([...ctx!.storage.uploads.values()][0]!.aborted).toBe(true);
    const got = await app().inject({ method: "GET", url: `/videos/${video.id}`, headers: bearer("alice") });
    expect(got.statusCode).toBe(404);
  });
});

describe("validación de archivos", () => {
  it("rechaza tipos que no son video", async () => {
    const res = await startUpload("alice", { filename: "malware.exe", mimeType: "application/x-msdownload" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("unsupported_type");
  });

  it("rechaza extensión y tipo que no coinciden", async () => {
    const res = await startUpload("alice", { filename: "pagina.mp4", mimeType: "text/html" });
    expect(res.json().error.code).toBe("unsupported_type");
  });

  it("rechaza archivos demasiado grandes o largos", async () => {
    const big = await startUpload("alice", { sizeBytes: DEFAULT_PRODUCT_CONFIG.upload.maxBytes + 1 });
    expect(big.json().error.code).toBe("file_too_large");
    const long = await startUpload("alice", { durationSeconds: DEFAULT_PRODUCT_CONFIG.upload.maxDurationSeconds + 1 });
    expect(long.json().error.code).toBe("video_too_long");
  });

  it("rechaza tamaños inválidos", async () => {
    expect((await startUpload("alice", { sizeBytes: 0 })).statusCode).toBe(400);
    expect((await startUpload("alice", { sizeBytes: -5 })).statusCode).toBe(400);
    expect((await startUpload("alice", { sizeBytes: "mucho" })).statusCode).toBe(400);
  });

  it("limita las subidas simultáneas por usuario", async () => {
    const projectId = await newProject("alice");
    for (let i = 0; i < DEFAULT_PRODUCT_CONFIG.upload.maxPendingUploads; i++) {
      expect((await startUpload("alice", { projectId })).statusCode).toBe(201);
    }
    const blocked = await startUpload("alice", { projectId });
    expect(blocked.statusCode).toBe(429);
  });

  it("no firma partes fuera de rango", async () => {
    const { video } = (await startUpload("alice")).json();
    const res = await app().inject({
      method: "POST",
      url: `/videos/${video.id}/upload-parts`,
      headers: bearer("alice"),
      payload: { partNumbers: [4] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("aislamiento: un usuario no puede tocar videos de otro", () => {
  it("no puede subir un video al proyecto de otro usuario", async () => {
    const aliceProject = await newProject("alice");
    const res = await startUpload("bob", { projectId: aliceProject });
    expect(res.statusCode).toBe(404);
    expect(ctx!.storage.uploads.size).toBe(0); // ni siquiera se abrió la subida en S3
  });

  it("no puede ver, firmar partes, completar ni cancelar el video de otro", async () => {
    const { video } = (await startUpload("alice")).json();
    const asBob = bearer("bob");
    const calls = [
      app().inject({ method: "GET", url: `/videos/${video.id}`, headers: asBob }),
      app().inject({ method: "POST", url: `/videos/${video.id}/upload-parts`, headers: asBob, payload: { partNumbers: [1] } }),
      app().inject({
        method: "POST",
        url: `/videos/${video.id}/complete`,
        headers: asBob,
        payload: { parts: [1, 2, 3].map((n) => ({ partNumber: n, etag: "e" })) },
      }),
      app().inject({ method: "POST", url: `/videos/${video.id}/abort`, headers: asBob }),
    ];
    for (const res of await Promise.all(calls)) expect(res.statusCode).toBe(404);

    const list = await app().inject({ method: "GET", url: "/videos", headers: asBob });
    expect(list.json().videos).toEqual([]);
    const still = await app().inject({ method: "GET", url: `/videos/${video.id}`, headers: bearer("alice") });
    expect(still.json().status).toBe("pending_upload");
  });

  it("exige sesión", async () => {
    expect((await app().inject({ method: "GET", url: "/videos" })).statusCode).toBe(401);
    expect((await app().inject({ method: "POST", url: "/videos", payload: {} })).statusCode).toBe(401);
  });
});
