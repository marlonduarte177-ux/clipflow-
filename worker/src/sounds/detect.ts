import type { SoundEvent } from "@clipflow/shared";
import { decodeAudioSamples, type FfmpegTools } from "../ffmpeg.js";
import { buildSoundEvents, PATCH_HOP_SECONDS, scoreAudioStream } from "./yamnet.js";

/** Tope de sonidos por video (los más seguros): suficiente para marcar la transcripción sin inflarla. */
const MAX_EVENTS = 400;

/**
 * Risas, gritos, aplausos y vítores del audio del video, con sus tiempos (detector YAMNet local, sin
 * costo por video). Analiza como mucho `maxSeconds` (lo mismo que se transcribe).
 */
export async function detectSounds(
  tools: FfmpegTools,
  input: string,
  options: { maxSeconds: number; signal?: AbortSignal; onProgress?: (seconds: number) => void },
): Promise<SoundEvent[]> {
  const perPatch = await scoreAudioStream(decodeAudioSamples(tools, input, options), {
    signal: options.signal,
    onPatches: (n) => options.onProgress?.(n * PATCH_HOP_SECONDS),
  });
  const events = buildSoundEvents(perPatch);
  if (events.length <= MAX_EVENTS) return events;
  const kept = new Set([...events].sort((a, b) => b.confidence - a.confidence).slice(0, MAX_EVENTS));
  return events.filter((e) => kept.has(e));
}
