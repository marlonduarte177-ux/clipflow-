import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_PRODUCT_CONFIG } from "@clipflow/shared";
import { createJob, schema, upsertUser, type Database } from "@clipflow/shared/db";
import { createLocalStorage } from "./storage.js";
import type { PipelineDeps } from "./pipeline.js";

/**
 * Video de prueba de 40 s: audio alto entre los segundos 20 y 26,
 * y dos cambios de escena (segundos 10 y 30).
 */
export function makeSampleVideo(file: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=40",
    "-f", "lavfi", "-i", "aevalsrc='if(between(t\\,20\\,26)\\,0.8\\,0.02)*sin(2*PI*440*t)':s=44100:d=40",
    "-f", "lavfi", "-i", "color=c=red:size=640x360:rate=25:duration=40",
    "-filter_complex", "[0:v][2:v]overlay=enable='between(t,10,11)+between(t,30,31)'[v]",
    "-map", "[v]", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", file,
  ]);
}

/**
 * Video vertical 720x1280 con la imagen real horizontal en el centro, franjas negras
 * arriba y abajo y una "marca de agua" blanca en la franja inferior (como un TikTok resubido).
 */
export function makeLetterboxedVideo(file: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=720x405:rate=25:duration=40",
    "-f", "lavfi", "-i", "aevalsrc='if(between(t\\,25\\,30)\\,0.8\\,0.02)*sin(2*PI*440*t)':s=44100:d=40",
    "-filter_complex", "[0:v]pad=720:1280:0:437:black,drawbox=x=520:y=1100:w=150:h=20:color=white@1:t=fill[v]",
    "-map", "[v]", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", file,
  ]);
}

export async function seedVideoJob(
  db: Database,
  root: string,
  options: { sample: string; fake?: boolean; params?: Record<string, unknown> },
) {
  const user = await upsertUser(db, { cognitoSub: `sub-${Math.random()}` });
  const [project] = await db.insert(schema.projects).values({ userId: user.id, name: "P" }).returning();
  const key = `originals/${user.id}/v/original.mp4`;
  const target = path.join(root, key);
  mkdirSync(path.dirname(target), { recursive: true });
  if (options.fake) writeFileSync(target, "<html>esto no es un video</html>");
  else execFileSync("cp", [options.sample, target]);
  const [video] = await db
    .insert(schema.videos)
    .values({
      userId: user.id,
      projectId: project!.id,
      originalFilename: "sample.mp4",
      mimeType: "video/mp4",
      sizeBytes: 1000,
      s3Key: key,
      status: "uploaded",
    })
    .returning();
  const { job } = await createJob(db, {
    userId: user.id,
    videoId: video!.id,
    type: "analyze_video",
    idempotencyKey: `analyze:${video!.id}`,
    params: { clipDurationSeconds: 15, ...options.params },
  });
  return { user, video: video!, job };
}

export function makeDeps(db: Database, root: string, workDir: string): PipelineDeps {
  return {
    db,
    storage: createLocalStorage(root),
    tools: { ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" },
    product: DEFAULT_PRODUCT_CONFIG,
    workDir,
    workerId: "test-worker",
    costPerHourUsd: 0.0987,
    ai: null,
    aiDisabledReason: "IA no configurada en tests",
    aiMaxAudioMinutes: 180,
    log: { info: () => undefined, warn: () => undefined },
  };
}
