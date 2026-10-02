import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { claimJob, failJob, schema, type DbHandle } from "@clipflow/shared/db";
import { createTestDb } from "@clipflow/shared/db/testing";
import { DownloadError } from "./download.js";
import { JobError, processAnalyzeJob } from "./pipeline.js";
import { makeDeps, makeGameplayVideo, makeLetterboxedVideo, makeSampleVideo, seedVideoJob } from "./test-helpers.js";

let h: DbHandle | undefined;
let root: string;
let sample: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "clipflow-worker-"));
  sample = path.join(root, "sample.mp4");
  makeSampleVideo(sample);
});
beforeEach(async () => {
  await h?.close();
  h = await createTestDb();
});
afterAll(async () => {
  await h?.close();
  rmSync(root, { recursive: true, force: true });
});

function probeSize(file: string) {
  return execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file])
    .toString()
    .trim();
}

describe("procesamiento de un video real con FFmpeg", () => {
  it("valida, analiza, elige el momento con más señal y genera clips 9:16 con miniatura", async () => {
    const db = h!.db;
    const { job, video } = await seedVideoJob(db, root, { sample });
    const claimed = (await claimJob(db, job.id, "test-worker"))!;
    const workDir = path.join(root, "work");

    const result = await processAnalyzeJob(claimed, makeDeps(db, root, workDir));
    expect(result.clipCount).toBeGreaterThan(0);

    // El video quedó validado con su duración real.
    const [v] = await db.select().from(schema.videos).where(eq(schema.videos.id, video.id));
    expect(v).toMatchObject({ status: "ready", width: 640, height: 360 });
    expect(v!.durationSeconds).toBeCloseTo(40, 0);

    // El primer clip cubre el tramo de audio alto (20–26 s).
    const clipRows = await db.select().from(schema.clips).where(eq(schema.clips.jobId, job.id));
    const loud = clipRows.find((c) => c.startSeconds <= 20 && c.endSeconds >= 26);
    expect(loud).toBeDefined();
    expect(loud!.endSeconds - loud!.startSeconds).toBe(15);
    expect(loud!.score).toBeGreaterThanOrEqual(0.6);
    expect(loud!.scoreBreakdown).toHaveProperty("audio");

    // Los archivos existen y son verticales 1080x1920.
    for (const c of clipRows) {
      expect(probeSize(path.join(root, c.s3Key!))).toBe("1080,1920");
      expect(existsSync(path.join(root, c.thumbnailS3Key!))).toBe(true);
    }

    // Consumo registrado y carpeta temporal limpia.
    const usage = await db.select().from(schema.usage).where(eq(schema.usage.jobId, job.id));
    expect(usage.map((u) => u.metric).sort()).toEqual(["clips_generated", "processing_seconds", "video_seconds_processed"]);
    expect(usage.find((u) => u.metric === "processing_seconds")!.estimatedCostUsd).toBeGreaterThan(0);
    expect(existsSync(path.join(workDir, job.id))).toBe(false);

    // Progreso real guardado.
    const [j] = await db.select().from(schema.processingJobs).where(eq(schema.processingJobs.id, job.id));
    expect(j!.progress).toBeGreaterThanOrEqual(95);
  });

  it("repetir el trabajo reemplaza los clips en vez de duplicarlos", async () => {
    const db = h!.db;
    const { job } = await seedVideoJob(db, root, { sample });
    const deps = makeDeps(db, root, path.join(root, "work"));
    const first = await processAnalyzeJob((await claimJob(db, job.id, "test-worker"))!, deps);
    // Simula que el primer intento falló al final y el trabajo volvió a la cola.
    await failJob(db, job.id, "test-worker", { code: "x", message: "x", retryable: true });
    await processAnalyzeJob((await claimJob(db, job.id, "test-worker"))!, deps);
    const rows = await db.select().from(schema.clips).where(eq(schema.clips.jobId, job.id));
    expect(rows).toHaveLength(first.clipCount);
  });

  it("rechaza archivos que no son video sin reintentar", async () => {
    const db = h!.db;
    const { job, video } = await seedVideoJob(db, root, { sample, fake: true });
    const claimed = (await claimJob(db, job.id, "test-worker"))!;
    const error = await processAnalyzeJob(claimed, makeDeps(db, root, path.join(root, "work"))).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobError);
    expect(error).toMatchObject({ code: "invalid_video", retryable: false });
    const [v] = await db.select().from(schema.videos).where(eq(schema.videos.id, video.id));
    expect(v).toMatchObject({ status: "rejected" });
    expect(readdirSync(path.join(root, "work"))).toEqual([]);
  });

  it("un video sin variación (plano) termina sin clips: no inventa momentos", async () => {
    const db = h!.db;
    const flat = path.join(root, "flat.mp4");
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=blue:size=320x180:rate=25:duration=40",
      "-f", "lavfi", "-i", "sine=frequency=300:duration=40",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", flat,
    ]);
    const { job } = await seedVideoJob(db, root, { sample: flat });
    const result = await processAnalyzeJob(
      (await claimJob(db, job.id, "test-worker"))!,
      makeDeps(db, root, path.join(root, "work")),
    );
    expect(result.clipCount).toBe(0);
    const [j] = await db.select().from(schema.processingJobs).where(eq(schema.processingJobs.id, job.id));
    expect(j!.status).toBe("processing"); // el consumidor lo marca "completed" (0 clips es un resultado válido)
  });
});

describe("encuadre vertical", () => {
  /** Zona con imagen (no negra) del clip, según cropdetect. */
  function visibleArea(file: string) {
    const out = execFileSync("sh", ["-c", `ffmpeg -hide_banner -i "${file}" -vf cropdetect=limit=24:round=2 -frames:v 20 -f null - 2>&1`]).toString();
    return [...out.matchAll(/crop=(\d+):(\d+)/g)].pop()?.slice(1).map(Number);
  }

  it("video vertical con franjas: se acerca un poco sin recortar a 9:16 y la marca de agua desaparece", async () => {
    const db = h!.db;
    const letterboxed = path.join(root, "letterbox.mp4");
    makeLetterboxedVideo(letterboxed);
    const { job } = await seedVideoJob(db, root, { sample: letterboxed });
    const result = await processAnalyzeJob((await claimJob(db, job.id, "test-worker"))!, makeDeps(db, root, path.join(root, "work")));
    expect(result.clipCount).toBeGreaterThan(0);
    const [clip] = await db.select().from(schema.clips).where(eq(schema.clips.jobId, job.id));
    const file = path.join(root, clip!.s3Key!);
    expect(probeSize(file)).toBe("1080,1920");
    // Imagen de 720x405 dentro de 720x1280: sin acercar ocuparía 1080x607; con el zoom de 1.25,
    // ~1080x750. La marca de agua de la franja inferior ya no aparece (el área no llega hasta abajo).
    const [width, height] = visibleArea(file)!;
    expect(width).toBe(1080);
    expect(height).toBeGreaterThan(700);
    expect(height).toBeLessThan(800);
  });
});

describe("gameplay sin voz", () => {
  it("los disparos (picos de sonido cortos) definen el mejor momento", async () => {
    const db = h!.db;
    const gameplay = path.join(root, "gameplay.mp4");
    makeGameplayVideo(gameplay);
    const { job } = await seedVideoJob(db, root, { sample: gameplay, params: { clipDurationSeconds: 15 } });
    await processAnalyzeJob((await claimJob(db, job.id, "test-worker"))!, makeDeps(db, root, path.join(root, "work")));
    const rows = await db.select().from(schema.clips).where(eq(schema.clips.jobId, job.id));
    const best = [...rows].sort((a, b) => b.score! - a.score!)[0]!;
    // El clip con mejor score cae dentro de la balacera (35–45 s).
    expect(best.startSeconds).toBeGreaterThanOrEqual(28);
    expect(best.endSeconds).toBeLessThanOrEqual(52);
    expect(best.scoreBreakdown).toHaveProperty("action");
  });
});

describe("videos importados por enlace", () => {
  it("descarga el enlace, lo guarda como original, usa el título como nombre y genera clips", async () => {
    const db = h!.db;
    const { job, video } = await seedVideoJob(db, root, { sample, importUrl: "https://www.tiktok.com/@ana/video/1" });
    const calls: string[] = [];
    const deps = {
      ...makeDeps(db, root, path.join(root, "work")),
      download: async (url: string, dir: string, options: { onProgress?: (f: number) => void }) => {
        calls.push(url);
        options.onProgress?.(0.5);
        const file = path.join(dir, "source.mp4");
        execFileSync("cp", [sample, file]);
        return { file, sizeBytes: statSync(file).size, title: "Mi entrevista: parte 1" };
      },
    };
    const result = await processAnalyzeJob((await claimJob(db, job.id, "test-worker"))!, deps);
    expect(calls).toEqual(["https://www.tiktok.com/@ana/video/1"]);
    expect(result.clipCount).toBeGreaterThan(0);

    const [row] = await db.select().from(schema.videos).where(eq(schema.videos.id, video.id));
    expect(row).toMatchObject({ status: "ready", originalFilename: "Mi entrevista: parte 1.mp4", mimeType: "video/mp4" });
    expect(row!.sizeBytes).toBe(statSync(sample).size);
    // El original quedó en S3 (aquí, almacenamiento local) para poder reprocesar sin volver a descargar.
    expect(statSync(path.join(root, video.s3Key)).size).toBe(statSync(sample).size);
    const usage = await db.select().from(schema.usage).where(eq(schema.usage.videoId, video.id));
    expect(usage.find((u) => u.metric === "storage_bytes")).toMatchObject({ details: { event: "import_completed" } });
  });

  it("solo descargar: guarda el original listo para bajarlo, sin analizar ni crear clips", async () => {
    const db = h!.db;
    const { job, video } = await seedVideoJob(db, root, { sample, importUrl: "https://www.tiktok.com/@ana/video/2", params: { downloadOnly: true } });
    const deps = {
      ...makeDeps(db, root, path.join(root, "work")),
      download: async (_url: string, dir: string) => {
        const file = path.join(dir, "source.mp4");
        execFileSync("cp", [sample, file]);
        return { file, sizeBytes: statSync(file).size, title: "Mi baile" };
      },
    };
    const result = await processAnalyzeJob((await claimJob(db, job.id, "test-worker"))!, deps);
    expect(result).toMatchObject({ clipCount: 0, downloadOnly: true });

    const [row] = await db.select().from(schema.videos).where(eq(schema.videos.id, video.id));
    expect(row).toMatchObject({ status: "ready", originalFilename: "Mi baile.mp4" });
    expect(row!.durationSeconds).toBeCloseTo(40, 0);
    expect(statSync(path.join(root, video.s3Key)).size).toBe(statSync(sample).size);
    expect(await db.select().from(schema.clips).where(eq(schema.clips.videoId, video.id))).toHaveLength(0);
  });

  it("si el enlace no se puede descargar, el video queda rechazado con un mensaje claro", async () => {
    const db = h!.db;
    const { job, video } = await seedVideoJob(db, root, { sample, importUrl: "https://www.instagram.com/reel/privado/" });
    const deps = {
      ...makeDeps(db, root, path.join(root, "work")),
      download: async () => {
        throw new DownloadError("Este video es privado o pide iniciar sesión, así que no se puede descargar.", false);
      },
    };
    const error = await processAnalyzeJob((await claimJob(db, job.id, "test-worker"))!, deps).catch((e) => e);
    expect(error).toMatchObject({ code: "import_failed", retryable: false });
    const [row] = await db.select().from(schema.videos).where(eq(schema.videos.id, video.id));
    expect(row).toMatchObject({ status: "rejected", rejectionReason: "Este video es privado o pide iniciar sesión, así que no se puede descargar." });
  });

  it("reintentar un enlace que falló vuelve a descargarlo (no busca un archivo que nunca existió)", async () => {
    const db = h!.db;
    const { job, video } = await seedVideoJob(db, root, { sample, importUrl: "https://vt.tiktok.com/abc/" });
    await db
      .update(schema.videos)
      .set({ status: "rejected", rejectionReason: "No pudimos descargar el video de ese enlace." })
      .where(eq(schema.videos.id, video.id));
    let downloads = 0;
    const deps = {
      ...makeDeps(db, root, path.join(root, "work")),
      download: async (_url: string, dir: string) => {
        downloads++;
        const file = path.join(dir, "source.mp4");
        execFileSync("cp", [sample, file]);
        return { file, sizeBytes: statSync(file).size, title: null };
      },
    };
    const result = await processAnalyzeJob((await claimJob(db, job.id, "test-worker"))!, deps);
    expect(downloads).toBe(1);
    expect(result.clipCount).toBeGreaterThan(0);
    const [row] = await db.select().from(schema.videos).where(eq(schema.videos.id, video.id));
    expect(row).toMatchObject({ status: "ready", rejectionReason: null });
  });

  it("un corte temporal se reintenta sin rechazar el video", async () => {
    const db = h!.db;
    const { job, video } = await seedVideoJob(db, root, { sample, importUrl: "https://example.com/v.mp4" });
    const deps = {
      ...makeDeps(db, root, path.join(root, "work")),
      download: async () => {
        throw new DownloadError("La descarga se cortó. Lo intentaremos de nuevo.", true);
      },
    };
    const error = await processAnalyzeJob((await claimJob(db, job.id, "test-worker"))!, deps).catch((e) => e);
    expect(error).toMatchObject({ code: "import_failed", retryable: true });
    const [row] = await db.select().from(schema.videos).where(eq(schema.videos.id, video.id));
    expect(row!.status).toBe("importing");
  });

  it("un error inesperado dice en qué paso falló y su código, sin detalles internos", async () => {
    const db = h!.db;
    const { job, video } = await seedVideoJob(db, root, { sample, importUrl: "https://vt.tiktok.com/abc/" });
    const base = makeDeps(db, root, path.join(root, "work"));
    const warnings: Record<string, unknown>[] = [];
    const deps = {
      ...base,
      log: { info: () => undefined, warn: (o: Record<string, unknown>) => void warnings.push(o) },
      download: async (_url: string, dir: string) => {
        const file = path.join(dir, "source.mp4");
        execFileSync("cp", [sample, file]);
        return { file, sizeBytes: statSync(file).size, title: "Mi video" };
      },
      storage: {
        ...base.storage,
        upload: async () => {
          throw Object.assign(new Error("User arn:aws:sts::123:assumed-role/x is not authorized"), { name: "AccessDenied" });
        },
      },
    };
    const error = await processAnalyzeJob((await claimJob(db, job.id, "test-worker"))!, deps).catch((e) => e);
    expect(error).toBeInstanceOf(JobError);
    expect(error).toMatchObject({
      code: "unexpected",
      retryable: true,
      userMessage: "Ocurrió un error temporal al guardar el video importado (AccessDenied). Lo intentaremos de nuevo.",
    });
    // El detalle completo queda solo en el registro del worker.
    expect(warnings.find((w) => w.step === "guardar el video importado")).toMatchObject({ code: "AccessDenied" });
    const [row] = await db.select().from(schema.videos).where(eq(schema.videos.id, video.id));
    expect(row!.status).toBe("importing");
  });
});
