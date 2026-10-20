import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { claimJob, createJob, schema, type DbHandle } from "@clipflow/shared/db";
import { createTestDb } from "@clipflow/shared/db/testing";
import { processEditJob, wordsFromVtt } from "./edit.js";
import { processAnalyzeJob } from "./pipeline.js";
import { renderVerticalClip } from "./ffmpeg.js";
import { buildKaraokeAss, SUBTITLE_FONTS_DIR } from "./subtitles.js";
import { makeDeps, makeSampleVideo, seedVideoJob } from "./test-helpers.js";
import { pickActionMoments, viralVideoFilter } from "./viral.js";

let h: DbHandle | undefined;
let root: string;
let sample: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "clipflow-edit-"));
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

function streamInfo(file: string) {
  return execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height,r_frame_rate:format=duration", "-of", "json", file]).toString();
}

describe("modo viral: momentos fuertes", () => {
  it("elige los picos de volumen y los sonidos, separados; siempre hay un golpe al inicio", () => {
    // 20 s, nivel normal -30 dB; picos en 5 s y 5.5 s (muy juntos) y en 12 s.
    const loudness = Array.from({ length: 200 }, (_, i) => {
      const time = i / 10;
      const value = Math.abs(time - 5) < 0.05 ? -12 : Math.abs(time - 5.5) < 0.05 ? -14 : Math.abs(time - 12) < 0.05 ? -18 : -30;
      return { time, value };
    });
    const moments = pickActionMoments(20, loudness, [{ kind: "laughter", startSeconds: 16, endSeconds: 17, confidence: 0.9 }]);
    expect(moments.map((m) => m.atSeconds)).toEqual([0.05, 5, 12, 16]);
    expect(moments[0]).toMatchObject({ zoom: true, shake: false, flash: false }); // gancho suave
    expect(moments.find((m) => m.atSeconds === 5)).toMatchObject({ shake: true, flash: true });
  });

  it("un clip parejo (sin picos) lleva solo el gancho; el filtro sale a 60 fps con zoom y subtítulos", () => {
    const flat = Array.from({ length: 100 }, (_, i) => ({ time: i / 10, value: -30 }));
    const moments = pickActionMoments(10, flat);
    expect(moments).toHaveLength(1);
    const filter = viralVideoFilter(moments, { file: "/tmp/k.ass", fontsDir: "/fonts/" });
    expect(filter).toMatch(/^\[0:v:0\]fps=60,zoompan=/);
    expect(filter).toContain("ass=filename='/tmp/k.ass'");
    expect(filter).not.toContain("eq=brightness"); // sin flash
  });
});

describe("subtítulos karaoke", () => {
  it("palabra por palabra en MAYÚSCULAS, la que suena en amarillo con un «pop», en el tercio inferior", () => {
    const ass = buildKaraokeAss(
      [
        { startSeconds: 0.2, endSeconds: 0.5, text: "casi" },
        { startSeconds: 0.5, endSeconds: 0.8, text: "lo" },
        { startSeconds: 0.8, endSeconds: 1.3, text: "cazan" },
      ],
      5,
    )!;
    expect(ass).toContain("Style: Karaoke,Montserrat ExtraBold,96");
    const lines = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain("CASI LO {\\c&H0AD6FF&\\fscx118\\fscy118\\t(0,100,\\fscx100\\fscy100)}CAZAN");
    expect(buildKaraokeAss([], 5)).toBeNull();
  });

  it("clips anteriores al editor: las palabras salen de su WebVTT, repartidas dentro de cada frase", () => {
    const words = wordsFromVtt("WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nhola mundo\n\n00:00:04.000 --> 00:00:05.000\n<v A>otra</v>\n");
    expect(words.map((w) => w.text)).toEqual(["hola", "mundo", "otra"]);
    expect(words[0]!.startSeconds).toBe(1);
    expect(words[1]!.endSeconds).toBeCloseTo(3, 5);
    expect(words[2]).toMatchObject({ startSeconds: 4, endSeconds: 5 });
  });
});

describe("editar clips con FFmpeg", () => {
  it("una sola pasada genera el clip con subtítulos y la copia limpia (sin subtítulos)", async () => {
    const dir = path.join(root, "dual");
    mkdirSync(dir, { recursive: true });
    const ass = path.join(dir, "s.ass");
    execFileSync("sh", ["-c", `cat > ${ass}`], {
      input: buildKaraokeAss([{ startSeconds: 0, endSeconds: 3, text: "HOLA" }], 3)!,
    });
    const out = path.join(dir, "out.mp4");
    const clean = path.join(dir, "clean.mp4");
    await renderVerticalClip({ ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" }, sample, out, { startSeconds: 2, durationSeconds: 3 }, {
      subtitles: { file: ass, fontsDir: SUBTITLE_FONTS_DIR },
      cleanOutput: clean,
    });
    for (const f of [out, clean]) expect(Number(JSON.parse(streamInfo(f)).format.duration)).toBeCloseTo(3, 0);
    // El texto amarillo y blanco cambia la imagen: la copia limpia no lo tiene.
    const frame = (f: string) => execFileSync("ffmpeg", ["-v", "error", "-ss", "1", "-i", f, "-frames:v", "1", "-vf", "crop=1080:300:0:1250,scale=54:15", "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
    expect(frame(out).equals(frame(clean))).toBe(false);
  }, 60_000);

  async function editJob(db: DbHandle["db"], userId: string, videoId: string, clipIds: string[], music = true) {
    const { job } = await createJob(db, {
      userId,
      videoId,
      type: "render_clip",
      idempotencyKey: `edit:${Math.random()}`,
      params: { clipIds, edit: { mode: "viral", music } },
    });
    return (await claimJob(db, job.id, "test-worker"))!;
  }

  it("clip editable: guarda la copia limpia y sus datos; el modo viral sale 1080x1920 a 60 fps con música, aparte del original", async () => {
    const db = h!.db;
    const { job, video, user } = await seedVideoJob(db, root, { sample, params: { editable: true } });
    const deps = makeDeps(db, root, path.join(root, "work"));
    await processAnalyzeJob((await claimJob(db, job.id, "test-worker"))!, deps);
    const [clip] = await db.select().from(schema.clips).where(eq(schema.clips.jobId, job.id));
    // Sin subtítulos (no hay IA en tests): la copia limpia es el mismo clip; los datos, aparte.
    expect(clip!.cleanS3Key).toBe(clip!.s3Key);
    const data = JSON.parse(readFileSync(path.join(root, clip!.editDataS3Key!), "utf8"));
    expect(data).toMatchObject({ version: 1, words: [], sounds: [] });

    // Una pista en la carpeta de música del bucket.
    mkdirSync(path.join(root, "music"), { recursive: true });
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=4", path.join(root, "music", "track.mp3")]);

    const edit = await editJob(db, user.id, video.id, [clip!.id]);
    const result = await processEditJob(edit, deps);
    expect(result.clipCount).toBe(1);
    const [after] = await db.select().from(schema.clips).where(eq(schema.clips.id, clip!.id));
    expect(after!.editedS3Key).toBe(`clips/${user.id}/${edit.id}/${clip!.id}.mp4`);
    expect(after!.s3Key).toBe(clip!.s3Key); // el clip original no cambia
    expect(after!.edit).toMatchObject({ mode: "viral", music: true, jobId: edit.id });
    const info = JSON.parse(streamInfo(path.join(root, after!.editedS3Key!)));
    const v = info.streams.find((s: { codec_type: string }) => s.codec_type === "video");
    expect(v).toMatchObject({ width: 1080, height: 1920, r_frame_rate: "60/1" });
    expect(info.streams.some((s: { codec_type: string }) => s.codec_type === "audio")).toBe(true);
    expect(Number(info.format.duration)).toBeCloseTo(15, 0);
    const [j] = await db.select().from(schema.processingJobs).where(eq(schema.processingJobs.id, edit.id));
    expect(j!.progress).toBeGreaterThanOrEqual(90);
  }, 120_000);

  it("clip anterior al editor de un archivo subido: se rehace del original; de un enlace sin original, no", async () => {
    const db = h!.db;
    const { job, video, user } = await seedVideoJob(db, root, { sample });
    const deps = makeDeps(db, root, path.join(root, "work2"));
    await processAnalyzeJob((await claimJob(db, job.id, "test-worker"))!, deps);
    const [clip] = await db.select().from(schema.clips).where(eq(schema.clips.jobId, job.id));
    expect(clip!.cleanS3Key).toBeNull();

    const result = await processEditJob(await editJob(db, user.id, video.id, [clip!.id], false), deps);
    expect(result.clipCount).toBe(1);
    const [after] = await db.select().from(schema.clips).where(eq(schema.clips.id, clip!.id));
    expect(existsSync(path.join(root, after!.editedS3Key!))).toBe(true);
    expect(after!.edit).toMatchObject({ music: false });

    // Si el original ya no está (enlace cuyo original se borró), dice qué hacer.
    await db.update(schema.videos).set({ sourceUrl: "https://kick.com/x/videos/1", probe: { clipflowOriginalDeleted: true } }).where(eq(schema.videos.id, video.id));
    await expect(processEditJob(await editJob(db, user.id, video.id, [clip!.id]), deps)).rejects.toMatchObject({ code: "edit_source_missing" });
  }, 120_000);
});
