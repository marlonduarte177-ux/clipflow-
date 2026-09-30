import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { AIAnalysisProvider, AudioChunk, TranscriptSegment } from "@clipflow/shared";
import { claimJob, schema, type DbHandle } from "@clipflow/shared/db";
import { createTestDb } from "@clipflow/shared/db/testing";
import { processAnalyzeJob } from "./pipeline.js";
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
  constructor(
    private readonly fail = false,
    private readonly segments: TranscriptSegment[] = SEGMENTS,
  ) {}
  async transcribe(chunks: AudioChunk[]) {
    if (this.fail) throw new Error("OpenAI caído");
    this.receivedChunks = chunks;
    return { segments: this.segments, language: "spanish", usage: { audioSeconds: 40, estimatedCostUsd: 0.004 } };
  }
  async analyze() {
    this.analyzeCalls++;
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

describe("procesamiento con IA", () => {
  it("usa el contenido para elegir momentos, corta en frases, pone títulos y genera subtítulos", async () => {
    const db = h!.db;
    const { job } = await seedVideoJob(db, root, { sample });
    const fakeAI = new FakeAI();
    const deps = { ...makeDeps(db, root, path.join(root, "work")), ai: fakeAI };
    const result = await processAnalyzeJob((await claimJob(db, job.id, "test-worker"))!, deps);

    expect(result).toMatchObject({ ai: "used", language: "spanish" });
    // Solo se envía audio, en trozos, que cubren el video.
    const total = fakeAI.receivedChunks.reduce((s, c) => s + c.durationSeconds, 0);
    expect(total).toBeGreaterThan(38);
    expect(fakeAI.receivedChunks.every((c) => c.path.endsWith(".mp3"))).toBe(true);

    const clipRows = await db.select().from(schema.clips).where(eq(schema.clips.jobId, job.id));
    const hook = clipRows.find((c) => c.startSeconds <= 2 && c.endSeconds >= 12);
    expect(hook).toBeDefined();
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

    const usage = await db.select().from(schema.usage).where(eq(schema.usage.jobId, job.id));
    const metric = (m: string) => usage.find((u) => u.metric === m);
    expect(metric("ai_audio_seconds")).toMatchObject({ quantity: 40, estimatedCostUsd: 0.004 });
    expect(metric("ai_input_tokens")!.quantity).toBe(600);
    expect(metric("ai_output_tokens")!.quantity).toBe(70);
  });

  it("si la IA falla, el video se procesa igual y el resultado lo dice", async () => {
    const db = h!.db;
    const { job } = await seedVideoJob(db, root, { sample });
    const deps = { ...makeDeps(db, root, path.join(root, "work")), ai: new FakeAI(true) };
    const result = await processAnalyzeJob((await claimJob(db, job.id, "test-worker"))!, deps);
    expect(result.ai).toBe("unavailable");
    expect(result.aiReason).toMatch(/solo por audio y escenas/);
    expect(result.clipCount).toBeGreaterThan(0);
    const subs = await db.select().from(schema.subtitles).where(eq(schema.subtitles.videoId, job.videoId));
    expect(subs).toEqual([]);
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
