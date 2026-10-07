import { spawn } from "node:child_process";
import type { ContentBox, FfmpegTools } from "../ffmpeg.js";
import type { Detection, Sample } from "./framing.js";
import { detectFaces, YUNET_SIZE, type Face } from "./yunet.js";

/** Muestras por segundo que se analizan en cada clip. */
export const FACE_SAMPLES_PER_SECOND = 4;
/** Parches de boca y ojos: 20x10 grises. */
const PATCH_W = 20;
const PATCH_H = 10;
/** Diferencia media de una miniatura 16x9 (0–255) a partir de la cual se considera cambio de escena. */
const CUT_THRESHOLD = 25;

export interface FaceAnalysis {
  samples: Sample[];
  /** Tamaño de la imagen analizada (la zona con imagen real, reducida). */
  width: number;
  height: number;
  /** Píxeles originales por píxel analizado. */
  scale: number;
}

/**
 * Detecta caras en un clip: 4 imágenes por segundo de la zona con imagen real.
 * Para ir rápido, cada imagen se reduce a la mitad y se juntan varias en un mosaico de
 * 640x640 (una sola pasada del modelo detecta caras de 6 imágenes 16:9). La boca y los
 * ojos se miden en la imagen a tamaño completo del análisis (hasta 640 px).
 */
export async function analyzeFaces(
  tools: FfmpegTools,
  input: string,
  area: ContentBox,
  segment: { startSeconds: number; durationSeconds: number },
  signal?: AbortSignal,
): Promise<FaceAnalysis> {
  const s = Math.min(YUNET_SIZE / area.width, YUNET_SIZE / area.height, 1);
  const width = Math.max(4, Math.floor((area.width * s) / 4) * 4);
  const height = Math.max(4, Math.floor((area.height * s) / 4) * 4);
  const tileW = width / 2;
  const tileH = height / 2;
  const perMosaic = Math.max(1, Math.floor(YUNET_SIZE / tileW) * Math.floor(YUNET_SIZE / tileH));
  const cols = Math.floor(YUNET_SIZE / tileW);
  const frameBytes = width * height * 3;

  const child = spawn(
    tools.ffmpegPath,
    [
      "-hide_banner", "-nostdin", "-loglevel", "error",
      "-ss", segment.startSeconds.toFixed(3), "-i", input, "-t", segment.durationSeconds.toFixed(3), "-an",
      "-vf", `crop=${area.width}:${area.height}:${area.x}:${area.y},fps=${FACE_SAMPLES_PER_SECOND},scale=${width}:${height}`,
      "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (c: Buffer) => (stderr = (stderr + c.toString()).slice(-2000)));
  const onAbort = () => child.kill("SIGKILL");
  signal?.addEventListener("abort", onAbort, { once: true });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });

  const samples: Sample[] = [];
  let prevThumb: Float32Array | undefined;
  let batch: Uint8Array[] = [];

  const processBatch = async () => {
    if (batch.length === 0) return;
    // Mosaico: cada imagen reducida a la mitad (promedio 2x2) en su casilla.
    const mosaicH = Math.ceil(batch.length / cols) * tileH;
    const mosaic = new Uint8Array(YUNET_SIZE * mosaicH * 3);
    batch.forEach((frame, i) => {
      const ox = (i % cols) * tileW;
      const oy = Math.floor(i / cols) * tileH;
      for (let y = 0; y < tileH; y++) {
        for (let x = 0; x < tileW; x++) {
          for (let c = 0; c < 3; c++) {
            const a = ((2 * y) * width + 2 * x) * 3 + c;
            const b = a + width * 3;
            mosaic[((oy + y) * YUNET_SIZE + ox + x) * 3 + c] = (frame[a]! + frame[a + 3]! + frame[b]! + frame[b + 3]! + 2) >> 2;
          }
        }
      }
    });
    const faces = await detectFaces(mosaic, YUNET_SIZE, mosaicH);
    batch.forEach((frame, i) => {
      const ox = (i % cols) * tileW;
      const oy = Math.floor(i / cols) * tileH;
      const mine = faces.filter((f) => {
        const cx = f.x + f.width / 2;
        const cy = f.y + f.height / 2;
        return cx >= ox && cx < ox + tileW && cy >= oy && cy < oy + tileH && f.width >= 6;
      });
      const gray = toGray(frame, width, height);
      const detections: Detection[] = mine.map((f) => toFrameDetection(f, ox, oy, gray, width, height));
      const thumb = thumbnail(gray, width, height);
      const cut = prevThumb ? meanAbs(prevThumb, thumb) > CUT_THRESHOLD : false;
      prevThumb = thumb;
      samples.push({ t: samples.length / FACE_SAMPLES_PER_SECOND, cut, detections });
    });
    batch = [];
  };

  try {
    let pending: Buffer = Buffer.alloc(0);
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= frameBytes) {
        batch.push(new Uint8Array(pending.subarray(0, frameBytes)));
        pending = pending.subarray(frameBytes);
        if (batch.length === perMosaic) await processBatch();
      }
    }
    await processBatch();
    const code = await exited;
    if (signal?.aborted) throw new DOMException("Cancelado", "AbortError");
    if (code !== 0) throw new Error(`ffmpeg (caras) terminó con código ${code}: ${stderr}`);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  return { samples, width, height, scale: area.width / width };
}

function toGray(bgr: Uint8Array, width: number, height: number): Float32Array {
  const gray = new Float32Array(width * height);
  for (let i = 0; i < gray.length; i++) gray[i] = 0.114 * bgr[i * 3]! + 0.587 * bgr[i * 3 + 1]! + 0.299 * bgr[i * 3 + 2]!;
  return gray;
}

/** Parche de tamaño fijo (vecino más cercano) de una zona de la imagen en grises. */
function patch(gray: Float32Array, width: number, height: number, cx: number, cy: number, w: number, h: number): Float32Array {
  const out = new Float32Array(PATCH_W * PATCH_H);
  for (let py = 0; py < PATCH_H; py++) {
    for (let px = 0; px < PATCH_W; px++) {
      const x = Math.min(width - 1, Math.max(0, Math.round(cx - w / 2 + ((px + 0.5) * w) / PATCH_W)));
      const y = Math.min(height - 1, Math.max(0, Math.round(cy - h / 2 + ((py + 0.5) * h) / PATCH_H)));
      out[py * PATCH_W + px] = gray[y * width + x]!;
    }
  }
  return out;
}

/** Pasa una cara del mosaico a coordenadas de la imagen analizada, con parches de boca y ojos. */
function toFrameDetection(f: Face, ox: number, oy: number, gray: Float32Array, width: number, height: number): Detection {
  const pt = ([x, y]: [number, number]) => [(x - ox) * 2, (y - oy) * 2] as const;
  const [re, le, , mr, ml] = f.landmarks.map(pt);
  const faceW = f.width * 2;
  const mouthW = Math.max(Math.hypot(ml![0] - mr![0], ml![1] - mr![1]), 0.3 * faceW);
  const eyeW = Math.max(Math.hypot(le![0] - re![0], le![1] - re![1]), 0.3 * faceW);
  return {
    x: (f.x - ox) * 2,
    y: (f.y - oy) * 2,
    width: faceW,
    height: f.height * 2,
    mouth: patch(gray, width, height, (mr![0] + ml![0]) / 2, (mr![1] + ml![1]) / 2 + 0.1 * mouthW, 1.4 * mouthW, 0.8 * mouthW),
    eyes: patch(gray, width, height, (re![0] + le![0]) / 2, (re![1] + le![1]) / 2, 1.6 * eyeW, 0.6 * eyeW),
  };
}

/** Miniatura 16x9 (promedio por bloques) para detectar cambios de escena. */
function thumbnail(gray: Float32Array, width: number, height: number): Float32Array {
  const out = new Float32Array(16 * 9);
  const counts = new Float32Array(16 * 9);
  for (let y = 0; y < height; y++) {
    const by = Math.min(8, Math.floor((y * 9) / height));
    for (let x = 0; x < width; x++) {
      const i = by * 16 + Math.min(15, Math.floor((x * 16) / width));
      out[i] = out[i]! + gray[y * width + x]!;
      counts[i] = counts[i]! + 1;
    }
  }
  return out.map((v, i) => v / (counts[i] || 1));
}

function meanAbs(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / a.length;
}
