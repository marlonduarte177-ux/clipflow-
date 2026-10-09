import { fileURLToPath } from "node:url";
import type * as Ort from "onnxruntime-node";
import type { SoundEvent, SoundKind } from "@clipflow/shared";

/**
 * Detector de sonidos YAMNet (Google, licencia Apache 2.0; 521 clases de AudioSet), ejecutado con
 * onnxruntime en CPU dentro del worker: no se paga ninguna API. El modelo es el núcleo de la red
 * (parches log-mel → puntajes); el espectrograma log-mel se calcula aquí igual que en el código
 * original de TensorFlow (research/audioset/yamnet: features.py y params.py).
 */

export const YAMNET_SAMPLE_RATE = 16_000;
const WINDOW = 400; // 25 ms
const HOP = 160; // 10 ms
const FFT = 512;
const BINS = FFT / 2 + 1;
const MEL_BANDS = 64;
const MEL_MIN_HZ = 125;
const MEL_MAX_HZ = 7500;
const LOG_OFFSET = 0.001;
/** Un parche = 96 cuadros de 10 ms (0,96 s); uno nuevo cada 48 cuadros (0,48 s). */
export const PATCH_FRAMES = 96;
const PATCH_HOP_FRAMES = 48;
export const PATCH_SECONDS = 0.96;
export const PATCH_HOP_SECONDS = 0.48;
const NUM_CLASSES = 521;
/** Parches por llamada al modelo. */
const BATCH = 64;

/** Clases de AudioSet (índices de yamnet_class_map.csv) que forman cada sonido que nos interesa. */
export const SOUND_CLASSES: Record<SoundKind, number[]> = {
  // Laughter, Baby laughter, Giggle, Snicker, Belly laugh, Chuckle/chortle
  laughter: [13, 14, 15, 16, 17, 18],
  // Shout, Bellow, Whoop, Yell, Children shouting, Screaming
  scream: [6, 7, 8, 9, 10, 11],
  // Clapping, Applause
  applause: [58, 62],
  // Cheering
  cheer: [61],
};

/**
 * Puntaje mínimo de cada sonido para marcarlo. Los gritos piden más: la voz fuerte de un streamer
 * también suena un poco a "Shout".
 */
export const SOUND_THRESHOLDS: Record<SoundKind, number> = { laughter: 0.25, scream: 0.4, applause: 0.3, cheer: 0.3 };

const MODEL_PATH = fileURLToPath(new URL("../../models/yamnet.onnx", import.meta.url));

let runtime: Promise<{ ort: typeof Ort; session: Ort.InferenceSession }> | undefined;

/** Una sola sesión por proceso; 2 hilos para dejar CPU libre a FFmpeg. Sin telemetría. */
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

/** Puntajes del modelo para parches log-mel [n × 96 × 64] → [n × 521]. */
export async function scorePatches(patches: Float32Array, count: number): Promise<Float32Array> {
  const { ort, session } = await getRuntime();
  const input = new ort.Tensor("float32", patches, [count, PATCH_FRAMES, MEL_BANDS]);
  const output = await session.run({ [session.inputNames[0]!]: input });
  return output[session.outputNames[0]!]!.data as Float32Array;
}

const hertzToMel = (hz: number) => 1127 * Math.log(1 + hz / 700);

/** Igual que tf.signal.linear_to_mel_weight_matrix (escala HTK; la banda 0, de corriente continua, en 0). */
export function melWeights(): Float32Array {
  const weights = new Float32Array(BINS * MEL_BANDS);
  const lower = hertzToMel(MEL_MIN_HZ);
  const upper = hertzToMel(MEL_MAX_HZ);
  const edges = Array.from({ length: MEL_BANDS + 2 }, (_, i) => lower + ((upper - lower) * i) / (MEL_BANDS + 1));
  for (let bin = 1; bin < BINS; bin++) {
    const mel = hertzToMel((bin * (YAMNET_SAMPLE_RATE / 2)) / (BINS - 1));
    for (let m = 0; m < MEL_BANDS; m++) {
      const lowerSlope = (mel - edges[m]!) / (edges[m + 1]! - edges[m]!);
      const upperSlope = (edges[m + 2]! - mel) / (edges[m + 2]! - edges[m + 1]!);
      weights[bin * MEL_BANDS + m] = Math.max(0, Math.min(lowerSlope, upperSlope));
    }
  }
  return weights;
}

/** FFT compleja de 512 puntos (radix 2, en el lugar). */
function makeFft() {
  const levels = Math.log2(FFT);
  const reverse = new Uint16Array(FFT);
  for (let i = 0; i < FFT; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b);
    reverse[i] = r;
  }
  const cos = new Float64Array(FFT / 2);
  const sin = new Float64Array(FFT / 2);
  for (let i = 0; i < FFT / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / FFT);
    sin[i] = Math.sin((2 * Math.PI * i) / FFT);
  }
  return (re: Float64Array, im: Float64Array) => {
    for (let i = 0; i < FFT; i++) {
      const j = reverse[i]!;
      if (j > i) {
        [re[i], re[j]] = [re[j]!, re[i]!];
        [im[i], im[j]] = [im[j]!, im[i]!];
      }
    }
    for (let size = 2; size <= FFT; size *= 2) {
      const half = size / 2;
      const step = FFT / size;
      for (let start = 0; start < FFT; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * step]!;
          const wi = -sin[k * step]!;
          const a = start + k;
          const b = a + half;
          const tr = re[b]! * wr - im[b]! * wi;
          const ti = re[b]! * wi + im[b]! * wr;
          re[b] = re[a]! - tr;
          im[b] = im[a]! - ti;
          re[a] = re[a]! + tr;
          im[a] = im[a]! + ti;
        }
      }
    }
  };
}

/**
 * Convierte audio (16 kHz, mono, -1…1) en parches log-mel, de a pedazos: sirve para horas de audio sin
 * guardarlo entero en memoria. Da exactamente los mismos parches que el YAMNet original (con su relleno
 * final de silencio).
 */
export class LogMelPatcher {
  private readonly window = Float64Array.from({ length: WINDOW }, (_, n) => 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / WINDOW));
  private readonly mel = melWeights();
  private readonly fft = makeFft();
  private readonly re = new Float64Array(FFT);
  private readonly im = new Float64Array(FFT);
  /** Muestras pendientes (las que todavía no completan un cuadro). */
  private pending = new Float32Array(0);
  /** Cuadros log-mel aún no usados por completo (los últimos 48 se comparten con el parche siguiente). */
  private frames: Float32Array[] = [];
  private samplesSeen = 0;
  /** Parches emitidos hasta ahora (el índice da su tiempo: índice × 0,48 s). */
  emitted = 0;

  /** Agrega audio y devuelve los parches que ya se pueden calcular ([n × 96 × 64] y n). */
  push(samples: Float32Array): { patches: Float32Array; count: number } {
    this.samplesSeen += samples.length;
    const all = new Float32Array(this.pending.length + samples.length);
    all.set(this.pending);
    all.set(samples, this.pending.length);
    let offset = 0;
    for (; offset + WINDOW <= all.length; offset += HOP) this.frames.push(this.logMelFrame(all, offset));
    this.pending = all.slice(offset);
    return this.takePatches();
  }

  /** Termina: rellena con silencio como el original para completar el último parche. */
  finish(): { patches: Float32Array; count: number } {
    const minSamples = Math.round((PATCH_SECONDS + (WINDOW - HOP) / YAMNET_SAMPLE_RATE) * YAMNET_SAMPLE_RATE);
    const hopSamples = PATCH_HOP_SECONDS * YAMNET_SAMPLE_RATE;
    const total = Math.max(this.samplesSeen, minSamples);
    const padding = Math.max(0, minSamples - this.samplesSeen) + (hopSamples * Math.ceil((total - minSamples) / hopSamples) - (total - minSamples));
    return padding > 0 ? this.push(new Float32Array(padding)) : this.takePatches();
  }

  private logMelFrame(samples: Float32Array, offset: number): Float32Array {
    const { re, im } = this;
    for (let i = 0; i < FFT; i++) {
      re[i] = i < WINDOW ? samples[offset + i]! * this.window[i]! : 0;
      im[i] = 0;
    }
    this.fft(re, im);
    const out = new Float32Array(MEL_BANDS);
    for (let bin = 1; bin < BINS; bin++) {
      const magnitude = Math.hypot(re[bin]!, im[bin]!);
      if (magnitude === 0) continue;
      const row = bin * MEL_BANDS;
      for (let m = 0; m < MEL_BANDS; m++) out[m] = out[m]! + magnitude * this.mel[row + m]!;
    }
    for (let m = 0; m < MEL_BANDS; m++) out[m] = Math.log(out[m]! + LOG_OFFSET);
    return out;
  }

  private takePatches(): { patches: Float32Array; count: number } {
    const count = this.frames.length >= PATCH_FRAMES ? Math.floor((this.frames.length - PATCH_FRAMES) / PATCH_HOP_FRAMES) + 1 : 0;
    const patches = new Float32Array(count * PATCH_FRAMES * MEL_BANDS);
    for (let p = 0; p < count; p++) {
      for (let f = 0; f < PATCH_FRAMES; f++) patches.set(this.frames[p * PATCH_HOP_FRAMES + f]!, (p * PATCH_FRAMES + f) * MEL_BANDS);
    }
    this.frames = this.frames.slice(count * PATCH_HOP_FRAMES);
    this.emitted += count;
    return { patches, count };
  }
}

/** Puntaje de cada sonido en un parche: el de su clase más fuerte. */
export function kindScores(scores: Float32Array, patch: number): Record<SoundKind, number> {
  const base = patch * NUM_CLASSES;
  const out = {} as Record<SoundKind, number>;
  for (const [kind, classes] of Object.entries(SOUND_CLASSES) as [SoundKind, number[]][]) {
    out[kind] = Math.max(...classes.map((c) => scores[base + c]!));
  }
  return out;
}

/**
 * Une los parches seguidos donde se oye el mismo sonido en un evento con sus tiempos. Un hueco de un
 * parche no corta el evento (una risa con una pausa corta sigue siendo una risa).
 */
export function buildSoundEvents(
  perPatch: Record<SoundKind, number>[],
  offsetSeconds = 0,
  thresholds: Record<SoundKind, number> = SOUND_THRESHOLDS,
): SoundEvent[] {
  const events: SoundEvent[] = [];
  for (const kind of Object.keys(SOUND_CLASSES) as SoundKind[]) {
    let open: { first: number; last: number; max: number } | null = null;
    const close = () => {
      if (!open) return;
      events.push({
        kind,
        startSeconds: round2(offsetSeconds + open.first * PATCH_HOP_SECONDS),
        endSeconds: round2(offsetSeconds + open.last * PATCH_HOP_SECONDS + PATCH_SECONDS),
        confidence: round2(open.max),
      });
      open = null;
    };
    perPatch.forEach((scores, i) => {
      const value = scores[kind];
      if (value < thresholds[kind]) {
        if (open && i - open.last > 2) close();
        return;
      }
      if (open && i - open.last <= 2) {
        open.last = i;
        open.max = Math.max(open.max, value);
      } else {
        close();
        open = { first: i, last: i, max: value };
      }
    });
    close();
  }
  return events.sort((a, b) => a.startSeconds - b.startSeconds || a.kind.localeCompare(b.kind));
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Analiza un audio que llega de a pedazos (16 kHz mono float) y devuelve los puntajes por parche de
 * los sonidos que nos interesan.
 */
export async function scoreAudioStream(
  chunks: AsyncIterable<Float32Array>,
  options: { signal?: AbortSignal; onPatches?: (patches: number) => void } = {},
): Promise<Record<SoundKind, number>[]> {
  const patcher = new LogMelPatcher();
  const perPatch: Record<SoundKind, number>[] = [];
  let queue: Float32Array[] = [];
  let queued = 0;
  const flush = async () => {
    const size = PATCH_FRAMES * MEL_BANDS;
    const all = new Float32Array(queued * size);
    let at = 0;
    for (const q of queue) {
      all.set(q, at);
      at += q.length;
    }
    for (let start = 0; start < queued; start += BATCH) {
      const count = Math.min(BATCH, queued - start);
      const scores = await scorePatches(all.subarray(start * size, (start + count) * size), count);
      for (let p = 0; p < count; p++) perPatch.push(kindScores(scores, p));
      options.onPatches?.(perPatch.length);
      if (options.signal?.aborted) throw new DOMException("Cancelado", "AbortError");
    }
    queue = [];
    queued = 0;
  };
  const add = async ({ patches, count }: { patches: Float32Array; count: number }) => {
    if (count === 0) return;
    queue.push(patches);
    queued += count;
    if (queued >= BATCH) await flush();
  };
  for await (const chunk of chunks) {
    if (options.signal?.aborted) throw new DOMException("Cancelado", "AbortError");
    await add(patcher.push(chunk));
  }
  await add(patcher.finish());
  if (queued) await flush();
  return perPatch;
}
