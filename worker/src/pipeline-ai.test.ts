import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { fullTranscriptKey, transcriptCacheKey, type AIAnalysisProvider, type AudioChunk, type FrameSheet, type TranscriptSegment } from "@clipflow/shared";
import { claimJob, createJob, schema, type DbHandle } from "@clipflow/shared/db";
import { createTestDb } from "@clipflow/shared/db/testing";
import { AIProviderError } from "./ai/openai.js";
import { JobError, processAnalyzeJob } from "./pipeline.js";
import { makeDeps, makeSampleVideo, seedVideoJob } from "./test-helpers.js";

let h: DbHandle | undefined;
let root: string;
let sample: string;
beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "clipflow-ai-"));
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

/** Frases de 5 s a lo largo de los 40 s del video de prueba. */
const SEGMENTS: TranscriptSegment[] = Array.from({ length: 8 }, (_, i) => ({
  startSeconds: i * 5,
  endSeconds: i * 5 + 5,
  text: `Frase número ${i + 1}.`,
}));

/** Doble de prueba del proveedor de IA (no se usa en producción). */
class FakeAI implements AIAnalysisProvider {
  readonly name = "fake";
  receivedChunks: AudioChunk[] = [];
  analyzeCalls = 0;
  analyzeOptions: { targetClipSeconds?: number } | undefined;
  constructor(
    private readonly fail = false,
    private readonly segments: TranscriptSegment[] = SEGMENTS,
    private readonly failAnalysis: boolean | "rate_limit" = false,
  ) {}
  async transcribe(chunks: AudioChunk[]) {
    if (this.fail) {
      throw new AIProviderError(
        "Tu cuenta de OpenAI no tiene saldo o llegó a su límite de gasto (revisa Billing y Limits en platform.openai.com)",
        false,
        429,
        "insufficient_quota",
      );
    }
    this.receivedChunks = chunks;
    return { segments: this.segments, language: "spanish", usage: { audioSeconds: 40, estimatedCostUsd: 0.004 } };
  }
  async analyze(_segments: TranscriptSegment[], _duration: number, options?: { targetClipSeconds?: number }) {
    this.analyzeCalls++;
    this.analyzeOptions = options;
    if (this.failAnalysis === "rate_limit") {
      throw new AIProviderError("OpenAI limitó las solicitudes por minuto de tu cuenta (límite de velocidad)", true, 429, "rate_limit_exceeded");
    }
    if (this.failAnalysis) throw new AIProviderError("OpenAI devolvió JSON inválido", true);
    // El contenido importante está en una parte SILENCIOSA (2–12 s): sin IA no se elegiría.
    return {
      highlights: [{ startSeconds: 2, endSeconds: 12, strength: 1, reason: "gancho" }],
      usage: { inputTokens: 500, outputTokens: 50, estimatedCostUsd: 0.0001 },
    };
  }
  async generateClipSuggestions(_s: TranscriptSegment[], moments: { startSeconds: number }[]) {
    return { titles: moments.map((m) => `Título ${m.startSeconds}`), usage: { inputTokens: 100, outputTokens: 20, estimatedCostUsd: 0.00002 } };
  }
}

/** IA de prueba sin habla pero con visión: "ve" una eliminación en el segundo ~7. */
class FakeVisionAI implements AIAnalysisProvider {
  readonly name = "fake-vision";
  sheets: FrameSheet[] = [];
  /** Orden de las llamadas: las imágenes no deben competir con el análisis de texto. */
  calls: string[] = [];
  async transcribe() {
    this.calls.push("transcribe:start");
    await new Promise((r) => setTimeout(r, 300));
    this.calls.push("transcribe:end");
    return { segments: [], language: null, usage: { audioSeconds: 40, estimatedCostUsd: 0.004 } };
  }
  async analyze() {
    return { highlights: [], usage: {} };
  }
  async analyzeFrames(sheets: FrameSheet[], options?: { deadline?: number }) {
    this.calls.push("frames");
    expect(options?.deadline).toBeGreaterThan(Date.now());
    this.sheets = sheets;
    const frames = sheets.flatMap((s) =>
      s.frameTimes.map((t) => ({ timeSeconds: t, score: t > 4 && t < 11 ? 0.95 : 0.05, label: t > 4 && t < 11 ? "Eliminación doble" : "Corriendo" })),
    );
    return { frames, usage: { inputTokens: 2000, outputTokens: 150, estimatedCostUsd: 0.0004 } };
  }
  async generateClipSuggestions(_s: TranscriptSegment[], moments: unknown[]) {
    return { titles: moments.map(() => null), usage: {} };
  }
}

describe("análisis de imágenes con IA (experimental)", () => {
  it("lo que se ve en pantalla decide el momento, da el título y su costo queda separado", async () => {
    const db = h!.db;
    const { job } = await seedVideoJob(db, root, { sample });
    const ai = new FakeVisionAI();
    const deps = {
      ...makeDeps(db, root, path.join(root, "work")),
      ai,
      vision: { enabled: true, intervalSeconds: 3, maxFrames: 600 },
    };
    const result = await processAnalyzeJob((await claimJob(db, job.id, "test-worker"))!, deps);
    expect(result).toMatchObject({ vision: "used", ai: "no_speech" });
    expect(result.visionFrames).toBe(13); // 40 s / 3 s
    expect(ai.sheets).toHaveLength(2); // 9 + 4 fotogramas: 2 imágenes
    // Las imágenes se envían recién cuando terminó la transcripción/análisis de texto.
    expect(ai.calls).toEqual(["transcribe:start", "transcribe:end", "frames"]);
    expect(result.visionReason).toBeUndefined();

    const clipRows = await db.select().from(schema.clips).where(eq(schema.clips.jobId, job.id));
    const best = [...clipRows].sort((a, b) => b.score! - a.score!)[0]!;
    expect(best.startSeconds).toBeLessThanOrEqual(7);
    expect(best.endSeconds).toBeGreaterThanOrEqual(8);
    expect(best.title).toBe("Eliminación doble");
    expect(best.scoreBreakdown).toHaveProperty("vision");

    expect(result.costs).toMatchObject({ transcriptionUsd: 0.004, textUsd: 0, visionUsd: 0.0004 });
    expect(result.costs!.totalUsd).toBeGreaterThan(0.0044);
    const usage = await db.select().from(schema.usage).where(eq(schema.usage.jobId, job.id));
    expect(usage.some((u) => (u.details as { kind?: string } | null)?.kind === "vision" && u.quantity === 2000)).toBe(true);
  });

  it("apagado por defecto: no se envían imágenes", async () => {
    const db = h!.db;
    const { job } = await seedVideoJob(db, root, { sample });
    const ai = new FakeVisionAI();
    const result = await processAnalyzeJob((await claimJob(db, job.id, "test-worker"))!, {
      ...makeDeps(db, root, path.join(root, "work")),
      ai,
    });
    expect(result.vision).toBe("disabled");
    expect(ai.sheets).toEqual([]);
  });
});

describe("procesamiento con IA", () => {
  it("usa el contenido para elegir momentos, corta en frases, pone títulos y genera subtítulos", async () => {
    const db = h!.db;
    const { job } = await seedVideoJob(db, root, { sample });
    const fakeAI = new FakeAI();
    const deps = { ...makeDeps(db, root, path.join(root, "work")), ai: fakeAI };
    const result = await processAnalyzeJob((await claimJob(db, job.id, "test-worker"))!, deps);

    expect(result).toMatchObject({ ai: "used", language: "spanish", selection: "ai" });
    // La IA sabe qué largo eligió el usuario (guía) y decide el momento.
    expect(fakeAI.analyzeOptions?.targetClipSeconds).toBeGreaterThan(0);
    // Solo se envía audio, en trozos, que cubren el video.
    const total = fakeAI.receivedChunks.reduce((s, c) => s + c.durationSeconds, 0);
    expect(total).toBeGreaterThan(38);
    expect(fakeAI.receivedChunks.every((c) => c.path.endsWith(".mp3"))).toBe(true);

    const clipRows = await db.select().from(schema.clips).where(eq(schema.clips.jobId, job.id));
    // El clip es el momento de la IA (2–12 s), llevado hacia afuera a frases completas: 0–15 s.
    const hook = clipRows.find((c) => c.startSeconds <= 2 && c.endSeconds >= 12);
    expect(hook).toBeDefined();
    expect([hook!.startSeconds, hook!.endSeconds]).toEqual([0, 15]);
    expect(hook!.scoreBreakdown).toHaveProperty("speech");
    // Bordes en frases completas (múltiplos de 5 s en la transcripción de prueba).
    for (const c of clipRows) {
      expect(c.startSeconds % 5).toBe(0);
      expect(c.endSeconds % 5).toBe(0);
      expect(c.title).toBe(`Título ${c.startSeconds}`);
    }

    const subs = await db.select().from(schema.subtitles).where(eq(schema.subtitles.clipId, hook!.id));
    expect(subs.map((s) => s.format).sort()).toEqual(["srt", "vtt"]);
    const vtt = readFileSync(path.join(root, subs.find((s) => s.format === "vtt")!.s3Key), "utf8");
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    expect(vtt).toContain("00:00:00.000 -->");

    // Transcripción completa del video, para la web.
    const full = readFileSync(path.join(root, fullTranscriptKey(job.userId, job.id)), "utf8");
    expect(full.startsWith("WEBVTT")).toBe(true);
    expect(full).toContain("Frase número 8.");

    const usage = await db.select().from(schema.usage).where(eq(schema.usage.jobId, job.id));
    const metric = (m: string) => usage.find((u) => u.metric === m);
    expect(metric("ai_audio_seconds")).toMatchObject({ quantity: 40, estimatedCostUsd: 0.004 });
    expect(metric("ai_input_tokens")!.quantity).toBe(600);
    expect(metric("ai_output_tokens")!.quantity).toBe(70);
  });

  it("los subtítulos quedan dibujados en el video según el estilo elegido", async () => {
    const db = h!.db;
    /** Píxeles (grises) de una franja del cuadro del segundo t. */
    const band = (file: string, t: number, y: number) =>
      execFileSync("ffmpeg", [
        "-loglevel", "error", "-ss", String(t), "-i", file, "-frames:v", "1",
        "-vf", `crop=1080:300:0:${y},scale=216:60,format=gray`, "-f", "rawvideo", "-",
      ]);
    const diff = (a: Buffer, b: Buffer) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]!), 0) / a.length;
    const hookClip = async (subtitleStyle: string) => {
      const { job } = await seedVideoJob(db, root, { sample, params: { subtitleStyle } });
      const deps = { ...makeDeps(db, root, path.join(root, "work")), ai: new FakeAI() };
      await processAnalyzeJob((await claimJob(db, job.id, "test-worker"))!, deps);
      const rows = await db.select().from(schema.clips).where(eq(schema.clips.jobId, job.id));
      return path.join(root, rows.find((c) => c.startSeconds <= 2 && c.endSeconds >= 12)!.s3Key!);
    };
    const withSubs = await hookClip("highlight");
    const without = await hookClip("none");
    // Mismo clip; solo cambia la franja de los subtítulos (abajo de la imagen central).
    expect(diff(band(withSubs, 1, 1200), band(without, 1, 1200))).toBeGreaterThan(8);
    expect(diff(band(withSubs, 1, 450), band(without, 1, 450))).toBeLessThan(2);
  });

  it("si la IA falla, el video se procesa igual y el resultado lo dice", async () => {
    const db = h!.db;
    const { job } = await seedVideoJob(db, root, { sample });
    const deps = { ...makeDeps(db, root, path.join(root, "work")), ai: new FakeAI(true) };
    const result = await processAnalyzeJob((await claimJob(db, job.id, "test-worker"))!, deps);
    expect(result.ai).toBe("unavailable");
    // El motivo real llega a la web (sin detalles internos).
    expect(result.aiReason).toBe(
      "falló la transcripción: Tu cuenta de OpenAI no tiene saldo o llegó a su límite de gasto (revisa Billing y Limits en platform.openai.com)",
    );
    expect(result.clipCount).toBeGreaterThan(0);
    const subs = await db.select().from(schema.subtitles).where(eq(schema.subtitles.videoId, job.videoId));
    expect(subs).toEqual([]);
  });

  it("si falla solo el análisis, la transcripción (ya pagada) se conserva: subtítulos, títulos y su costo", async () => {
    const db = h!.db;
    const { job } = await seedVideoJob(db, root, { sample });
    const deps = { ...makeDeps(db, root, path.join(root, "work")), ai: new FakeAI(false, SEGMENTS, true) };
    const result = await processAnalyzeJob((await claimJob(db, job.id, "test-worker"))!, deps);
    expect(result).toMatchObject({ ai: "unavailable", aiReason: "falló el análisis de momentos: OpenAI devolvió JSON inválido", language: "spanish" });
    expect(result.costs!.transcriptionUsd).toBeCloseTo(0.004);
    expect(result.clipCount).toBeGreaterThan(0);
    const subs = await db.select().from(schema.subtitles).where(eq(schema.subtitles.videoId, job.videoId));
    expect(subs.length).toBeGreaterThan(0);
    const clips = await db.select().from(schema.clips).where(eq(schema.clips.jobId, job.id));
    expect(clips.some((c) => c.title?.startsWith("Título"))).toBe(true);
  });

  it("OpenAI saturado (límite por minuto): reintenta el trabajo más tarde en vez de clips sin IA; en el último intento sigue sin ella", async () => {
    const db = h!.db;
    const { job } = await seedVideoJob(db, root, { sample });
    const ai = new FakeAI(false, SEGMENTS, "rate_limit");
    const deps = { ...makeDeps(db, root, path.join(root, "work")), ai };
    const error = await processAnalyzeJob((await claimJob(db, job.id, "test-worker"))!, deps).catch((e) => e);
    expect(error).toBeInstanceOf(JobError);
    expect(error).toMatchObject({ code: "ai_busy", retryable: true });
    expect(error.userMessage).toMatch(/Lo reintentamos en unos minutos/);
    expect(await db.select().from(schema.clips).where(eq(schema.clips.jobId, job.id))).toEqual([]);

    // Último intento: ya no se espera más; se crean los clips por señales y se dice por qué.
    await db.update(schema.processingJobs).set({ attempts: 2, status: "queued", lockedBy: null }).where(eq(schema.processingJobs.id, job.id));
    const result = await processAnalyzeJob((await claimJob(db, job.id, "test-worker"))!, deps);
    expect(result).toMatchObject({ ai: "unavailable", selection: "signals" });
    expect(result.clipCount).toBeGreaterThan(0);
  });

  it("la transcripción se guarda por video y se reutiliza al volver a procesar: no se paga dos veces", async () => {
    const db = h!.db;
    const { job, video } = await seedVideoJob(db, root, { sample });
    const ai = Object.assign(new FakeAI(), { transcriptionModel: "whisper-1" });
    let transcribeCalls = 0;
    const transcribe = ai.transcribe.bind(ai);
    ai.transcribe = async (chunks) => (transcribeCalls++, transcribe(chunks));
    const deps = { ...makeDeps(db, root, path.join(root, "work")), ai };

    const first = await processAnalyzeJob((await claimJob(db, job.id, "test-worker"))!, deps);
    expect(transcribeCalls).toBe(1);
    expect(first.costs!.transcriptionUsd).toBeCloseTo(0.004);
    // Guardada en la carpeta de ESE usuario y ESE video, con el modelo en el nombre.
    const key = transcriptCacheKey(job.userId, video.id, "fake", "whisper-1-sync");
    expect(key).toBe(`transcripts/${job.userId}/${video.id}/fake-whisper-1-sync.json`);
    expect(existsSync(path.join(root, key))).toBe(true);

    // Otro procesamiento del mismo video (p. ej. otra duración de clips): sin volver a transcribir.
    const { job: again } = await createJob(db, {
      userId: job.userId,
      videoId: video.id,
      type: "analyze_video",
      idempotencyKey: `again:${video.id}`,
      params: { clipDurationSeconds: 15 },
    });
    const second = await processAnalyzeJob((await claimJob(db, again.id, "test-worker"))!, deps);
    expect(transcribeCalls).toBe(1);
    expect(second).toMatchObject({ ai: "used", language: "spanish" });
    expect(second.costs!.transcriptionUsd).toBe(0);
    // Con la transcripción reutilizada hay títulos (y subtítulos) igual que la primera vez.
    const clips = await db.select().from(schema.clips).where(eq(schema.clips.jobId, again.id));
    expect(clips.length).toBeGreaterThan(0);
    expect(clips.every((c) => c.title?.startsWith("Título"))).toBe(true);

    // Si cambia el tramo de audio (otro límite de minutos), no sirve: se transcribe de nuevo.
    const { job: shorter } = await createJob(db, {
      userId: job.userId,
      videoId: video.id,
      type: "analyze_video",
      idempotencyKey: `shorter:${video.id}`,
      params: { clipDurationSeconds: 15 },
    });
    await processAnalyzeJob((await claimJob(db, shorter.id, "test-worker"))!, { ...deps, aiMaxAudioMinutes: 0.5 });
    expect(transcribeCalls).toBe(2);
  });

  it("el MISMO enlace importado otra vez reutiliza la transcripción del video anterior (solo del mismo usuario)", async () => {
    const db = h!.db;
    const link = "https://www.tiktok.com/@ana/video/123";
    const { job, video } = await seedVideoJob(db, root, { sample, importUrl: link });
    const ai = Object.assign(new FakeAI(), { transcriptionModel: "whisper-1" });
    let transcribeCalls = 0;
    const transcribe = ai.transcribe.bind(ai);
    ai.transcribe = async (chunks) => (transcribeCalls++, transcribe(chunks));
    const deps = {
      ...makeDeps(db, root, path.join(root, "work")),
      ai,
      download: async (_url: string, dir: string) => {
        const file = path.join(dir, "source.mp4");
        execFileSync("cp", [sample, file]);
        return { file, sizeBytes: 1, title: "Mi video" };
      },
    };
    await processAnalyzeJob((await claimJob(db, job.id, "test-worker"))!, deps);
    expect(transcribeCalls).toBe(1);

    // Mismo usuario, mismo enlace, otro video en ClipFlow.
    const importAgain = async (userId: string, projectId: string) => {
      const [row] = await db
        .insert(schema.videos)
        .values({
          userId,
          projectId,
          originalFilename: "tiktok.com/@ana/video/123",
          mimeType: "video/mp4",
          sizeBytes: 0,
          s3Key: `originals/${userId}/${crypto.randomUUID()}/original.mp4`,
          status: "importing",
          sourceUrl: link,
          rightsConfirmedAt: new Date(),
        })
        .returning();
      const { job: j } = await createJob(db, { userId, videoId: row!.id, type: "analyze_video", idempotencyKey: `analyze:${row!.id}`, params: { clipDurationSeconds: 15 } });
      return { video: row!, job: j };
    };
    const same = await importAgain(job.userId, video.projectId);
    const result = await processAnalyzeJob((await claimJob(db, same.job.id, "test-worker"))!, deps);
    expect(transcribeCalls).toBe(1);
    expect(result.costs!.transcriptionUsd).toBe(0);
    // Queda una copia propia para el video nuevo (se borra con él).
    expect(existsSync(path.join(root, transcriptCacheKey(job.userId, same.video.id, "fake", "whisper-1-sync")))).toBe(true);

    // OTRO usuario con el mismo enlace: no recibe la transcripción ajena, se transcribe para él.
    const other = await seedVideoJob(db, root, { sample, importUrl: link });
    await processAnalyzeJob((await claimJob(db, other.job.id, "test-worker"))!, deps);
    expect(transcribeCalls).toBe(2);

    // Si los videos anteriores duran otra cosa (se bajaron desde otro punto), sus tiempos no sirven:
    // se transcribe de nuevo para que los subtítulos no queden corridos.
    await db
      .update(schema.videos)
      .set({ durationSeconds: 999 })
      .where(and(eq(schema.videos.userId, job.userId), eq(schema.videos.sourceUrl, link)));
    const shifted = await importAgain(job.userId, video.projectId);
    await processAnalyzeJob((await claimJob(db, shifted.job.id, "test-worker"))!, deps);
    expect(transcribeCalls).toBe(3);
  });

  it("sin habla real (gameplay) no inventa títulos ni subtítulos y lo indica", async () => {
    const db = h!.db;
    const { job } = await seedVideoJob(db, root, { sample });
    const almostSilent = new FakeAI(false, [{ startSeconds: 3, endSeconds: 5, text: "Crímenes en serie" }]);
    const deps = { ...makeDeps(db, root, path.join(root, "work")), ai: almostSilent };
    const result = await processAnalyzeJob((await claimJob(db, job.id, "test-worker"))!, deps);
    expect(result.ai).toBe("no_speech");
    expect(result.clipCount).toBeGreaterThan(0);
    expect(almostSilent.analyzeCalls).toBe(0);
    const clipRows = await db.select().from(schema.clips).where(eq(schema.clips.jobId, job.id));
    expect(clipRows.every((c) => c.title === null)).toBe(true);
    const subs = await db.select().from(schema.subtitles).where(eq(schema.subtitles.videoId, job.videoId));
    expect(subs).toEqual([]);
    // El costo de la transcripción sí se registra.
    const usage = await db.select().from(schema.usage).where(eq(schema.usage.jobId, job.id));
    expect(usage.find((u) => u.metric === "ai_audio_seconds")).toBeDefined();
  });

  it("sin clave de IA indica que está desactivada", async () => {
    const db = h!.db;
    const { job } = await seedVideoJob(db, root, { sample });
    const result = await processAnalyzeJob((await claimJob(db, job.id, "test-worker"))!, makeDeps(db, root, path.join(root, "work")));
    expect(result).toMatchObject({ ai: "disabled", aiReason: "IA no configurada en tests" });
    expect(existsSync(path.join(root, "work", job.id))).toBe(false);
  });
});
