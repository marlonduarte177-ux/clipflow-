import { fileURLToPath } from "node:url";
import type * as Ort from "onnxruntime-node";

/**
 * Detector de caras YuNet (OpenCV Zoo, licencia MIT), ejecutado con onnxruntime en CPU.
 * Corre dentro del worker: no se paga ninguna API por imagen.
 */

/** Cara detectada, en píxeles de la imagen analizada. */
export interface Face {
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
  /** Ojo derecho, ojo izquierdo, nariz, comisura derecha y comisura izquierda de la boca. */
  landmarks: [number, number][];
}

/** Tamaño de entrada fijo del modelo. */
export const YUNET_SIZE = 640;
const STRIDES = [8, 16, 32] as const;
const MODEL_PATH = fileURLToPath(new URL("../../models/face_detection_yunet_2023mar.onnx", import.meta.url));

let runtime: Promise<{ ort: typeof Ort; session: Ort.InferenceSession }> | undefined;

/**
 * Una sola sesión por proceso; 2 hilos para dejar CPU libre a FFmpeg.
 * onnxruntime trae telemetría de Microsoft: se apaga ANTES de cargarlo (no se envía nada).
 * Se carga solo la primera vez que se usa (si el seguimiento de caras está apagado, nunca).
 */
function getRuntime() {
  runtime ??= (async () => {
    process.env.ORT_DISABLE_TELEMETRY = "1";
    const ort = await import("onnxruntime-node");
    const session = await ort.InferenceSession.create(MODEL_PATH, {
      intraOpNumThreads: 2,
      interOpNumThreads: 1,
      graphOptimizationLevel: "all",
    });
    return { ort, session };
  })();
  return runtime;
}

/**
 * Detecta caras en una imagen BGR (3 bytes por píxel) de hasta 640x640.
 * @param minScore confianza mínima (0–1)
 */
export async function detectFaces(
  bgr: Uint8Array,
  width: number,
  height: number,
  minScore = 0.6,
): Promise<Face[]> {
  if (width > YUNET_SIZE || height > YUNET_SIZE) throw new Error("La imagen para detectar caras debe medir como máximo 640x640");
  // Formato del modelo: NCHW, BGR, valores 0–255, con relleno negro hasta 640x640.
  const plane = YUNET_SIZE * YUNET_SIZE;
  const input = new Float32Array(3 * plane);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 3;
      const dst = y * YUNET_SIZE + x;
      input[dst] = bgr[src]!;
      input[plane + dst] = bgr[src + 1]!;
      input[2 * plane + dst] = bgr[src + 2]!;
    }
  }
  const { ort, session } = await getRuntime();
  const out = await session.run({ input: new ort.Tensor("float32", input, [1, 3, YUNET_SIZE, YUNET_SIZE]) });

  const faces: Face[] = [];
  for (const stride of STRIDES) {
    const cls = out[`cls_${stride}`]!.data as Float32Array;
    const obj = out[`obj_${stride}`]!.data as Float32Array;
    const bbox = out[`bbox_${stride}`]!.data as Float32Array;
    const kps = out[`kps_${stride}`]!.data as Float32Array;
    const cols = YUNET_SIZE / stride;
    for (let i = 0; i < cls.length; i++) {
      const score = Math.sqrt(clamp01(cls[i]!) * clamp01(obj[i]!));
      if (score < minScore) continue;
      const r = Math.floor(i / cols);
      const c = i % cols;
      const cx = (c + bbox[i * 4]!) * stride;
      const cy = (r + bbox[i * 4 + 1]!) * stride;
      const w = Math.exp(bbox[i * 4 + 2]!) * stride;
      const h = Math.exp(bbox[i * 4 + 3]!) * stride;
      const landmarks: [number, number][] = [];
      for (let n = 0; n < 5; n++) {
        landmarks.push([(kps[i * 10 + 2 * n]! + c) * stride, (kps[i * 10 + 2 * n + 1]! + r) * stride]);
      }
      faces.push({ x: cx - w / 2, y: cy - h / 2, width: w, height: h, score, landmarks });
    }
  }
  // Solo caras dentro de la imagen real (no en el relleno).
  return nms(faces, 0.3).filter((f) => f.x + f.width / 2 < width && f.y + f.height / 2 < height);
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function iou(a: Pick<Face, "x" | "y" | "width" | "height">, b: Pick<Face, "x" | "y" | "width" | "height">): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

/** Quita detecciones repetidas de la misma cara (se queda con la de mayor confianza). */
function nms(faces: Face[], threshold: number): Face[] {
  const sorted = [...faces].sort((a, b) => b.score - a.score);
  const kept: Face[] = [];
  for (const face of sorted) if (kept.every((k) => iou(k, face) <= threshold)) kept.push(face);
  return kept;
}
