import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chooseVerticalCrop, detectContentBox, probe } from "./ffmpeg.js";

const tools = { ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" };
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ffmpeg-test-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Video horizontal con fondo quieto y un objeto moviéndose en el lado indicado. */
function actionVideo(file: string, side: "left" | "right", letterbox = false) {
  const x = side === "right" ? "1000" : "120";
  const scene =
    `[0:v][1:v]overlay=x=${x}+60*sin(t*3):y=300+200*sin(t*2)` + (letterbox ? ",scale=720:405,pad=720:1280:0:437:black" : "") + "[v]";
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=0x303030:size=1280x720:rate=25:duration=6",
    "-f", "lavfi", "-i", "testsrc2=size=160x160:rate=25:duration=6",
    "-filter_complex", scene, "-map", "[v]", "-c:v", "libx264", "-preset", "ultrafast", file,
  ]);
}

describe("encuadre inteligente", () => {
  it("sigue la acción: si pasa a la derecha, el recorte va a la derecha", async () => {
    const file = path.join(dir, "right.mp4");
    actionVideo(file, "right");
    const info = await probe(tools, file);
    const crop = await chooseVerticalCrop(tools, file, info, null, { startSeconds: 0, durationSeconds: 6 });
    expect(crop.width).toBe(404); // 720 * 9/16 redondeado a par
    expect(crop.height).toBe(720);
    expect(crop.x).toBeGreaterThan((1280 - 404) / 2);
  });

  it("y a la izquierda si la acción está a la izquierda", async () => {
    const file = path.join(dir, "left.mp4");
    actionVideo(file, "left");
    const info = await probe(tools, file);
    const crop = await chooseVerticalCrop(tools, file, info, null, { startSeconds: 0, durationSeconds: 6 });
    expect(crop.x).toBeLessThan((1280 - 404) / 2);
  });

  it("en un video con franjas negras, recorta dentro de la imagen real y sigue la acción", async () => {
    const file = path.join(dir, "letterbox-right.mp4");
    actionVideo(file, "right", true);
    const info = await probe(tools, file);
    const box = await detectContentBox(tools, file, info);
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(437);
    expect(box!.y + box!.height).toBeLessThanOrEqual(437 + 405);
    const crop = await chooseVerticalCrop(tools, file, info, box, { startSeconds: 0, durationSeconds: 6 });
    expect(crop.y).toBe(box!.y);
    expect(crop.height).toBe(box!.height);
    expect(crop.x).toBeGreaterThan((720 - crop.width) / 2);
  });

  it("un video sin franjas no se recorta de más", async () => {
    const file = path.join(dir, "plain.mp4");
    actionVideo(file, "right");
    expect(await detectContentBox(tools, file, await probe(tools, file))).toBeNull();
  });
});
