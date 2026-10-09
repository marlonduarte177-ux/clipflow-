import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { SoundKind } from "@clipflow/shared";
import { detectSounds } from "./detect.js";
import { buildSoundEvents, LogMelPatcher, PATCH_FRAMES, scorePatches } from "./yamnet.js";

/**
 * Resultado del YAMNet ORIGINAL (TensorFlow) con una señal de prueba: un barrido de tono y, desde
 * el segundo 1,5, un tono de 1 kHz. Lo generó el script de conversión del modelo.
 */
const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("../../test-fixtures/yamnet-chirp.json", import.meta.url)), "utf8")) as {
  samples: number;
  logMelShape: [number, number];
  logMelRow10: number[];
  logMelCol20: number[];
  patches: number;
  scoresTopClasses: number[];
  scores: number[][];
};

function chirp(): Float32Array {
  const sr = 16_000;
  return Float32Array.from({ length: fixture.samples }, (_, i) => {
    const t = i / sr;
    return 0.3 * Math.sin(2 * Math.PI * (220 * t + 400 * t * t)) + (t > 1.5 ? 0.2 * Math.sin(2 * Math.PI * 1000 * t) : 0);
  });
}

/** Pasa el audio en pedazos de tamaños raros (como llega de FFmpeg). */
function patchesOf(wave: Float32Array) {
  const patcher = new LogMelPatcher();
  const out: Float32Array[] = [];
  for (let at = 0, size = 1234; at < wave.length; at += size, size = size === 1234 ? 777 : 1234) {
    const { patches } = patcher.push(wave.subarray(at, at + size));
    out.push(patches);
  }
  out.push(patcher.finish().patches);
  const all = new Float32Array(out.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of out) {
    all.set(p, at);
    at += p.length;
  }
  return { all, count: all.length / (PATCH_FRAMES * 64) };
}

const root = mkdtempSync(path.join(tmpdir(), "yamnet-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("detector de sonidos YAMNet", () => {
  it("calcula el mismo espectrograma y los mismos puntajes que el YAMNet original", async () => {
    const { all, count } = patchesOf(chirp());
    expect(count).toBe(fixture.patches);
    // Cuadro f del espectrograma (TensorFlow calcula en float32: diferencias de ~0,001 en bandas casi mudas).
    // Cuadro f del espectrograma: está en el parche floor(f/48) (o el último), posición f − 48·parche.
    const frame = (f: number) => {
      const p = Math.min(count - 1, Math.floor(f / 48));
      return all.subarray((p * PATCH_FRAMES + (f - 48 * p)) * 64, (p * PATCH_FRAMES + (f - 48 * p) + 1) * 64);
    };
    expect(fixture.logMelShape[0]).toBe((count - 1) * 48 + PATCH_FRAMES);
    frame(10).forEach((v, m) => expect(v).toBeCloseTo(fixture.logMelRow10[m]!, 2));
    fixture.logMelCol20.forEach((v, f) => expect(frame(f)[20]).toBeCloseTo(v, 2));

    const scores = await scorePatches(all, count);
    fixture.scores.forEach((row, p) =>
      row.forEach((expected, k) => expect(scores[p * 521 + fixture.scoresTopClasses[k]!]).toBeCloseTo(expected, 3)),
    );
  });

  it("une los parches seguidos de un mismo sonido en un evento con sus tiempos", () => {
    const quiet: Record<SoundKind, number> = { laughter: 0, scream: 0, applause: 0, cheer: 0 };
    const perPatch = Array.from({ length: 20 }, () => ({ ...quiet }));
    // Risa en los parches 3–5 y 7 (un hueco de un parche no la corta), grito flojo (no llega) y aplausos al final.
    for (const i of [3, 4, 5, 7]) perPatch[i]!.laughter = 0.8;
    perPatch[4]!.laughter = 0.95;
    perPatch[10]!.scream = 0.35;
    perPatch[12]!.scream = 0.7;
    for (const i of [17, 18, 19]) perPatch[i]!.applause = 0.5;
    expect(buildSoundEvents(perPatch, 100)).toEqual([
      { kind: "laughter", startSeconds: 101.44, endSeconds: 104.32, confidence: 0.95 },
      { kind: "scream", startSeconds: 105.76, endSeconds: 106.72, confidence: 0.7 },
      { kind: "applause", startSeconds: 108.16, endSeconds: 110.08, confidence: 0.5 },
    ]);
  });

  it("lee el audio de un video con FFmpeg y no inventa sonidos en un tono continuo", async () => {
    const file = path.join(root, "tono.mp4");
    execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=12", "-c:a", "aac", file]);
    const progress: number[] = [];
    const events = await detectSounds({ ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" }, file, {
      maxSeconds: 10,
      onProgress: (s) => progress.push(s),
    });
    expect(events).toEqual([]);
    // 10 s analizados (con el relleno final): 20 parches de 0,48 s.
    expect(progress.at(-1)).toBeCloseTo(20 * 0.48, 1);
  });
});
