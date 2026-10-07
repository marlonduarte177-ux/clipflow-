import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chooseVerticalCrop, detectContentBox, extractAudioChunks, probe, renderVerticalClip } from "./ffmpeg.js";
import { detectFaces } from "./faces/yunet.js";

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
    // Recorte cuadrado (no a pantalla completa 9:16): se acerca menos.
    expect(crop).toMatchObject({ width: 720, height: 720, fill: "blur" });
    expect(crop.x).toBeGreaterThan((1280 - 720) / 2);
  });

  it("y a la izquierda si la acción está a la izquierda", async () => {
    const file = path.join(dir, "left.mp4");
    actionVideo(file, "left");
    const info = await probe(tools, file);
    const crop = await chooseVerticalCrop(tools, file, info, null, { startSeconds: 0, durationSeconds: 6 });
    expect(crop.x).toBeLessThan((1280 - 720) / 2);
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

describe("encuadre que sigue caras", () => {
  const photo = path.resolve(fileURLToPath(new URL("../test-fixtures/nasa-crew.jpg", import.meta.url)));
  /** Frame de un clip ya renderizado, en BGR a 540x960. */
  const outputFrame = (file: string, t: number) =>
    new Uint8Array(
      execFileSync("ffmpeg", ["-loglevel", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "scale=360:640", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]),
    );

  it("sigue a la persona aunque cambie de lado en un corte, y el clip final la muestra centrada", async () => {
    // Una sola cara (la 3.ª persona de la foto) a la izquierda 0–4 s y a la derecha 4–8 s, con cambio de fondo.
    const file = path.join(dir, "face-jump.mp4");
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=0x404850:size=1280x720:rate=25:duration=8",
      "-loop", "1", "-t", "8", "-i", photo,
      "-filter_complex",
      "[1:v]crop=150:170:345:80,scale=260:295[f];[0:v]drawbox=x=0:y=0:w=iw:h=ih:color=0x806040:t=fill:enable='gte(t,4)'[bg];" +
        "[bg][f]overlay=x='if(lt(t,4),300,780)':y=200[v]",
      "-map", "[v]", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", file,
    ]);
    const info = await probe(tools, file);
    const crop = await chooseVerticalCrop(tools, file, info, null, { startSeconds: 0, durationSeconds: 8 }, undefined, { faces: true });
    expect(crop.path).toBeDefined();
    const { positionAt } = await import("./faces/framing.js");
    const faceCenter = (left: number) => left + 130;
    expect(Math.abs(positionAt(crop.path!, 2) + crop.width / 2 - faceCenter(300))).toBeLessThan(60);
    expect(Math.abs(positionAt(crop.path!, 6) + crop.width / 2 - faceCenter(780))).toBeLessThan(60);

    // En el video final, la cara queda al centro antes y después del corte.
    const out = path.join(dir, "face-jump-vertical.mp4");
    await renderVerticalClip(tools, file, out, { startSeconds: 0, durationSeconds: 8 }, { crop });
    for (const t of [1.5, 3.5, 4.6, 7]) {
      const faces = (await detectFaces(outputFrame(out, t), 360, 640)).sort((a, b) => b.width - a.width);
      expect(faces.length, `cara en t=${t}`).toBeGreaterThanOrEqual(1);
      expect(Math.abs(faces[0]!.x + faces[0]!.width / 2 - 180), `centrada en t=${t}`).toBeLessThan(45);
    }
  });

  it("sin caras usa el encuadre por acción (sin trayectoria)", async () => {
    const file = path.join(dir, "no-faces.mp4");
    actionVideo(file, "right");
    const info = await probe(tools, file);
    const crop = await chooseVerticalCrop(tools, file, info, null, { startSeconds: 0, durationSeconds: 6 }, undefined, { faces: true });
    expect(crop.path).toBeUndefined();
    expect(crop.x).toBeGreaterThan((1280 - 720) / 2);

    // En el clip final, arriba y abajo va el mismo video difuminado (no negro).
    const out = path.join(dir, "no-faces-vertical.mp4");
    await renderVerticalClip(tools, file, out, { startSeconds: 0, durationSeconds: 2 }, { crop });
    const top = execFileSync("ffmpeg", ["-loglevel", "error", "-ss", "1", "-i", out, "-frames:v", "1", "-vf", "crop=1080:300:0:0,scale=36:10,format=gray", "-f", "rawvideo", "-"]);
    const mean = top.reduce((a, b) => a + b, 0) / top.length;
    expect(mean).toBeGreaterThan(20);
  });
});

describe("audio para transcribir", () => {
  it("si el audio empieza después que la imagen, el sonido queda en su segundo real (subtítulos en sincronía)", async () => {
    // Imagen desde 0 s; audio desde 2 s, con un pitido en el segundo 3 del audio = segundo 5 del video.
    const file = path.join(dir, "late-audio.mp4");
    execFileSync("ffmpeg", [
      "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:duration=10",
      "-itsoffset", "2", "-f", "lavfi", "-i", "aevalsrc=if(between(t\\,3\\,4)\\,sin(2*PI*1000*t)\\,0):s=44100:d=6",
      "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", file,
    ]);
    const work = path.join(dir, "late-audio-chunks");
    execFileSync("mkdir", ["-p", work]);
    const [chunk] = await extractAudioChunks(tools, file, work, { maxSeconds: 60 });
    const log = spawnSync("ffmpeg", ["-i", chunk!.path, "-af", "silencedetect=n=-30dB:d=0.5", "-f", "null", "-"]).stderr.toString();
    const beep = Number(/silence_end: ([\d.]+)/.exec(log)![1]);
    expect(beep).toBeGreaterThan(4.8);
    expect(beep).toBeLessThan(5.2);
  });
});
