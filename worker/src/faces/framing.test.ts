import { describe, expect, it } from "vitest";
import {
  buildTracks,
  chooseTargets,
  FRAMING,
  pathExpression,
  positionAt,
  smoothPath,
  toPieces,
  type Detection,
  type Sample,
} from "./framing.js";

const DT = 0.25; // 4 muestras por segundo
const still = new Float32Array(200).fill(100);
/** Boca que cambia en cada muestra (habla) o quieta. */
const mouth = (talking: boolean, k: number) => (talking ? new Float32Array(200).fill(k % 2 ? 130 : 90) : still);
const face = (x: number, talking = false, k = 0, size = 60): Detection => ({
  x,
  y: 100,
  width: size,
  height: size,
  mouth: mouth(talking, k),
  eyes: still,
});
const samples = (n: number, make: (k: number) => Detection[], cutAt: number[] = []): Sample[] =>
  Array.from({ length: n }, (_, k) => ({ t: k * DT, cut: cutAt.includes(k), detections: make(k) }));

describe("seguimiento de personas", () => {
  it("mantiene a cada persona aunque se mueva un poco y descarta detecciones sueltas", () => {
    const s = samples(12, (k) => [face(100 + k * 3), face(800 - k * 2), ...(k === 5 ? [face(450)] : [])]);
    const tracks = buildTracks(s);
    expect(tracks).toHaveLength(2);
    expect(tracks.map((t) => t.seen.size)).toEqual([12, 12]);
  });

  it("tolera que una cara no se detecte en una muestra", () => {
    const s = samples(10, (k) => (k === 4 ? [] : [face(300)]));
    const tracks = buildTracks(s);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]!.seen.size).toBe(9);
  });

  it("un cambio de escena empieza personas nuevas", () => {
    const s = samples(12, () => [face(300)], [6]);
    expect(buildTracks(s)).toHaveLength(2);
  });
});

describe("a quién encuadrar", () => {
  const crop = 300; // ancho del recorte 9:16
  it("si el grupo cabe en el 9:16, lo centra", () => {
    const s = samples(8, () => [face(100), face(250)]);
    const targets = chooseTargets(s, buildTracks(s), crop, 1200, DT);
    const groupCenter = (100 - 18 + 250 + 60 + 18) / 2;
    expect(targets.every((t) => t !== null && Math.abs(t - groupCenter) < 1)).toBe(true);
  });

  it("si no caben, sigue a quien habla y cambia cuando el otro habla claramente más", () => {
    // Derecha habla de 0 a 3.75 s; izquierda de 4 s en adelante.
    const s = samples(32, (k) => [face(100, k >= 16, k), face(900, k < 16, k)]);
    const targets = chooseTargets(s, buildTracks(s), crop, 1200, DT);
    const right = 930;
    const left = 130;
    expect(targets.slice(1, 16).every((t) => t === right)).toBe(true);
    // Justo después de que cambia, todavía no salta (histéresis)…
    expect(targets.slice(16, 19).every((t) => t === right)).toBe(true);
    // …y antes de 1.5 s ya encuadra a la izquierda.
    const switchedAt = targets.findIndex((t, k) => k >= 16 && t === left);
    expect(switchedAt).toBeGreaterThan(16);
    expect(switchedAt).toBeLessThanOrEqual(16 + FRAMING.switchSeconds / DT);
    expect(targets.slice(switchedAt).every((t) => t === left)).toBe(true);
  });

  it("en un diálogo rápido no rebota: se queda al menos 2 s con cada persona", () => {
    // Se turnan cada 1 s.
    const s = samples(40, (k) => [face(100, Math.floor(k / 4) % 2 === 0, k), face(900, Math.floor(k / 4) % 2 === 1, k)]);
    const targets = chooseTargets(s, buildTracks(s), crop, 1200, DT);
    const changes = targets.filter((t, k) => k > 0 && t !== targets[k - 1]).length;
    expect(changes).toBeLessThanOrEqual(40 / (FRAMING.holdSeconds / DT));
  });

  it("si nadie habla, encuadra a la cara más grande", () => {
    const s = samples(8, () => [face(100, false, 0, 40), face(900, false, 0, 90)]);
    const targets = chooseTargets(s, buildTracks(s), crop, 1200, DT);
    expect(targets.every((t) => t === 945)).toBe(true);
  });

  it("fuera de los momentos con voz, mover la boca no cuenta", () => {
    const s = samples(16, (k) => [face(100, true, k, 40), face(900, false, k, 90)]);
    const noVoice = chooseTargets(s, buildTracks(s), crop, 1200, DT, () => false);
    expect(noVoice.every((t) => t === 945)).toBe(true);
    const withVoice = chooseTargets(s, buildTracks(s), crop, 1200, DT, () => true);
    expect(withVoice.slice(2).every((t) => t === 120)).toBe(true);
  });

  it("si nadie habla y son parecidas, prefiere la más central", () => {
    const s = samples(8, () => [face(50, false, 0, 60), face(560, false, 0, 58)]);
    expect(chooseTargets(s, buildTracks(s), crop, 1200, DT).every((t) => t === 589)).toBe(true);
  });

  it("sin caras no hay objetivo", () => {
    const s = samples(6, () => []);
    expect(chooseTargets(s, buildTracks(s), crop, 1200, DT)).toEqual(new Array(6).fill(null));
  });
});

describe("movimiento de la cámara", () => {
  const crop = 300;
  const width = 1200;
  const noCuts = (n: number) => samples(n, () => []);

  it("temblores pequeños no mueven la cámara", () => {
    const targets = Array.from({ length: 20 }, (_, k) => 600 + (k % 2 ? 10 : -10));
    const path = smoothPath(noCuts(20), targets, crop, width, DT, 600);
    expect(new Set(path.map(Math.round)).size).toBe(1);
  });

  it("sigue un movimiento lento sin pasar la velocidad máxima", () => {
    const targets = Array.from({ length: 40 }, (_, k) => 400 + k * 8);
    const path = smoothPath(noCuts(40), targets, crop, width, DT, 400);
    const maxStep = FRAMING.maxSpeed * crop * DT;
    for (let i = 1; i < path.length; i++) expect(Math.abs(path[i]! - path[i - 1]!)).toBeLessThanOrEqual(maxStep + 1e-9);
    expect(path[path.length - 1]!).toBeGreaterThan(600);
  });

  it("salta directo si el objetivo está lejos (cambio de persona)", () => {
    const targets = Array.from({ length: 12 }, (_, k) => (k < 6 ? 200 : 1000));
    const path = smoothPath(noCuts(12), targets, crop, width, DT, 600);
    expect(path[4]).toBe(200);
    expect(path[9]).toBe(1000);
  });

  it("nunca se sale de la imagen", () => {
    const targets = [0, 0, 0, 5000, 5000, 5000];
    const path = smoothPath(noCuts(6), targets, crop, width, DT, 600);
    expect(Math.min(...path)).toBe(crop / 2);
    expect(Math.max(...path)).toBe(width - crop / 2);
  });

  it("una escena sin caras usa el encuadre alternativo", () => {
    const s = samples(8, () => [], [4]);
    const targets = [300, 300, 300, 300, null, null, null, null];
    const path = smoothPath(s, targets, crop, width, DT, 777);
    expect(path.slice(0, 4)).toEqual([300, 300, 300, 300]);
    expect(path.slice(4)).toEqual([777, 777, 777, 777]);
  });
});

describe("trayectoria para FFmpeg", () => {
  /** Evalúa la expresión como lo haría FFmpeg (solo usa gte, lt, +, *, / y t). */
  const evaluate = (expr: string, t: number) =>
    Function("t", `return ${expr.replace(/gte\(t,([\d.]+)\)/g, "(t>=$1?1:0)").replace(/lt\(t,([\d.]+)\)/g, "(t<$1?1:0)")};`)(t) as number;

  it("tramos contiguos desde 0, rectas simplificadas y saltos a mitad entre muestras", () => {
    const times = Array.from({ length: 12 }, (_, k) => k * DT);
    const xs = [100, 100, 100, 110, 120, 130, 140, 500, 500, 500, 500, 500];
    const pieces = toPieces(times, xs, DT, 120);
    expect(pieces[0]!.start).toBe(0);
    expect(pieces[pieces.length - 1]!.end).toBe(Infinity);
    for (let i = 1; i < pieces.length; i++) expect(pieces[i]!.start).toBe(pieces[i - 1]!.end);
    expect(pieces.length).toBeLessThanOrEqual(5);
    times.forEach((t, k) => expect(positionAt(pieces, t)).toBeCloseTo(xs[k]!, 5));
    // El salto ocurre entre 1.5 s y 1.75 s.
    expect(positionAt(pieces, 1.6)).toBe(140);
    expect(positionAt(pieces, 1.65)).toBe(500);
  });

  it("la expresión de FFmpeg da la misma posición que la trayectoria", () => {
    const times = Array.from({ length: 40 }, (_, k) => k * DT);
    const xs = times.map((t) => (t < 5 ? 200 + 30 * t : 800));
    const pieces = toPieces(times, xs, DT, 150);
    const expr = pathExpression(pieces);
    for (let t = 0; t < 12; t += 0.04) expect(evaluate(expr, t)).toBeCloseTo(Math.round(positionAt(pieces, t)), -0.5);
  });
});
