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

  it("un video vertical con una imagen horizontal y franjas: solo se acerca un poco, sin recortar a 9:16", async () => {
    const file = path.join(dir, "letterbox-right.mp4");
    actionVideo(file, "right", true);
    const info = await probe(tools, file);
    const box = await detectContentBox(tools, file, info);
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(437);
    expect(box!.y + box!.height).toBeLessThanOrEqual(437 + 405);
    const crop = await chooseVerticalCrop(tools, file, info, box, { startSeconds: 0, durationSeconds: 6 });
    expect(crop.fit).toBe(true);
    // Zoom 1.25: se ve el 80 % del ancho de la imagen (antes solo ~31 %).
    expect(crop.width).toBeGreaterThanOrEqual(Math.floor((box!.width * 0.8) / 2) * 2 - 2);
    expect(crop.width / crop.height).toBeCloseTo(720 / 1280, 2);
    // Centrado en la imagen y movido hacia donde está la acción.
    expect(crop.y).toBeLessThanOrEqual(box!.y);
    expect(crop.y + crop.height).toBeGreaterThanOrEqual(box!.y + box!.height);
    expect(crop.x).toBeGreaterThan((720 - crop.width) / 2);
  });

  it("un video vertical sin franjas no se recorta nada", async () => {
    const file = path.join(dir, "vertical.mp4");
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=720x1280:rate=25:duration=3",
      "-c:v", "libx264", "-preset", "ultrafast", file,
    ]);
    const info = await probe(tools, file);
    const box = await detectContentBox(tools, file, info);
    const crop = await chooseVerticalCrop(tools, file, info, box, { startSeconds: 0, durationSeconds: 3 });
    expect(crop).toEqual({ x: 0, y: 0, width: 720, height: 1280, fit: true });
  });

  it("un video vertical de celular guardado con marca de giro se reconoce como vertical", async () => {
    const flat = path.join(dir, "flat.mp4");
    const turned = path.join(dir, "turned.mp4");
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=2",
      "-c:v", "libx264", "-preset", "ultrafast", flat,
    ]);
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-display_rotation", "90", "-i", flat, "-c", "copy", turned]);
    const info = await probe(tools, turned);
    expect({ width: info.width, height: info.height }).toEqual({ width: 360, height: 640 });
    const crop = await chooseVerticalCrop(tools, turned, info, null, { startSeconds: 0, durationSeconds: 2 });
    expect(crop).toEqual({ x: 0, y: 0, width: 360, height: 640, fit: true });
  });

  it("un video sin franjas no se recorta de más", async () => {
    const file = path.join(dir, "plain.mp4");
    actionVideo(file, "right");
    expect(await detectContentBox(tools, file, await probe(tools, file))).toBeNull();
  });
});

describe("hojas de fotogramas para la IA", () => {
  it("agrupa 1 fotograma cada 3 s en cuadrículas 3x3 con el tiempo real de cada uno", async () => {
    const { buildFrameSheets } = await import("./ffmpeg.js");
    const file = path.join(dir, "timed.mp4");
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=40",
      "-c:v", "libx264", "-preset", "ultrafast", file,
    ]);
    const work = path.join(dir, "sheets");
    execFileSync("mkdir", ["-p", work]);
    const sheets = await buildFrameSheets(tools, file, work, await probe(tools, file), { intervalSeconds: 3, box: null });
    expect(sheets.map((s) => s.frameTimes.length)).toEqual([9, 4]); // 13 fotogramas en 40 s
    expect(sheets[1]!.frameTimes).toEqual([28.5, 31.5, 34.5, 37.5]);
    const size = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", sheets[0]!.path]);
    expect(size.toString().trim()).toBe("1536,864");
  });
});
