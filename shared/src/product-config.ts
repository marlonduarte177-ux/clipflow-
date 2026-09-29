/**
 * Configuración central del producto.
 *
 * Todos los valores "de negocio" (duraciones de clip, pesos del score, límites)
 * viven aquí y en ningún otro sitio. Cada uno puede sobrescribirse con una
 * variable de entorno sin tocar el código.
 */

export interface ScoreWeights {
  audio: number;
  speech: number;
  visual: number;
  ocr: number;
  reaction: number;
}

export interface ProductConfig {
  /** Duraciones de clip permitidas, en segundos. */
  clipDurationsSeconds: number[];
  /** Peso de cada señal en el score de interés (se normalizan al usarse). */
  scoreWeights: ScoreWeights;
  /** Score mínimo (0–1) para que un momento se convierta en clip. */
  minClipScore: number;
  /** Máximo de clips por video. Se generan solo los que superan minClipScore. */
  maxClipsPerVideo: number;
  upload: {
    maxBytes: number;
    maxDurationSeconds: number;
    allowedMimeTypes: string[];
  };
}

export const DEFAULT_PRODUCT_CONFIG: ProductConfig = {
  clipDurationsSeconds: [15, 30, 45, 60, 90],
  scoreWeights: { audio: 0.25, speech: 0.35, visual: 0.2, ocr: 0.05, reaction: 0.15 },
  minClipScore: 0.6,
  maxClipsPerVideo: 15,
  upload: {
    maxBytes: 10 * 1024 ** 3,
    maxDurationSeconds: 3 * 60 * 60,
    allowedMimeTypes: ["video/mp4", "video/quicktime", "video/webm", "video/x-matroska"],
  },
};

type Env = Record<string, string | undefined>;

function positiveNumber(name: string, raw: string): number {
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name}: "${raw}" no es un número positivo`);
  }
  return value;
}

function numberList(name: string, raw: string): number[] {
  const values = raw.split(",").map((part) => positiveNumber(name, part));
  if (values.length === 0) throw new Error(`${name} no puede estar vacío`);
  return [...new Set(values)].sort((a, b) => a - b);
}

function stringList(name: string, raw: string): string[] {
  const values = raw.split(",").map((part) => part.trim()).filter(Boolean);
  if (values.length === 0) throw new Error(`${name} no puede estar vacío`);
  return values;
}

function fraction(name: string, raw: string): number {
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name}: "${raw}" debe estar entre 0 y 1`);
  }
  return value;
}

/** Lee la configuración desde variables de entorno, usando los valores por defecto si faltan. */
export function loadProductConfig(env: Env = process.env): ProductConfig {
  const d = DEFAULT_PRODUCT_CONFIG;
  const get = (name: string) => {
    const v = env[name];
    return v !== undefined && v.trim() !== "" ? v : undefined;
  };
  const weight = (key: keyof ScoreWeights) => {
    const name = `SCORE_WEIGHT_${key.toUpperCase()}`;
    const raw = get(name);
    if (raw === undefined) return d.scoreWeights[key];
    const value = Number(raw.trim());
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name}: "${raw}" debe ser >= 0`);
    return value;
  };

  const scoreWeights: ScoreWeights = {
    audio: weight("audio"),
    speech: weight("speech"),
    visual: weight("visual"),
    ocr: weight("ocr"),
    reaction: weight("reaction"),
  };
  if (Object.values(scoreWeights).every((w) => w === 0)) {
    throw new Error("Al menos un peso del score debe ser mayor que 0");
  }

  const raw = {
    durations: get("CLIP_DURATIONS_SECONDS"),
    minScore: get("MIN_CLIP_SCORE"),
    maxClips: get("MAX_CLIPS_PER_VIDEO"),
    maxBytes: get("UPLOAD_MAX_BYTES"),
    maxDuration: get("UPLOAD_MAX_DURATION_SECONDS"),
    mimes: get("UPLOAD_ALLOWED_MIME_TYPES"),
  };

  return {
    clipDurationsSeconds: raw.durations
      ? numberList("CLIP_DURATIONS_SECONDS", raw.durations)
      : d.clipDurationsSeconds,
    scoreWeights,
    minClipScore: raw.minScore ? fraction("MIN_CLIP_SCORE", raw.minScore) : d.minClipScore,
    maxClipsPerVideo: raw.maxClips
      ? Math.floor(positiveNumber("MAX_CLIPS_PER_VIDEO", raw.maxClips))
      : d.maxClipsPerVideo,
    upload: {
      maxBytes: raw.maxBytes ? positiveNumber("UPLOAD_MAX_BYTES", raw.maxBytes) : d.upload.maxBytes,
      maxDurationSeconds: raw.maxDuration
        ? positiveNumber("UPLOAD_MAX_DURATION_SECONDS", raw.maxDuration)
        : d.upload.maxDurationSeconds,
      allowedMimeTypes: raw.mimes
        ? stringList("UPLOAD_ALLOWED_MIME_TYPES", raw.mimes)
        : d.upload.allowedMimeTypes,
    },
  };
}
