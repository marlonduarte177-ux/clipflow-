/**
 * Encuadre que sigue caras (lógica pura, sin FFmpeg ni modelo: fácil de probar).
 *
 * Entrada: caras detectadas en muestras del clip (4 por segundo), con un parche de la boca y otro
 * de los ojos en escala de grises. Salida: la posición horizontal del recorte 9:16 en el tiempo.
 *
 * 1. Seguir a cada persona entre muestras (cajas cercanas = la misma persona).
 * 2. Saber quién habla: cuánto cambia su boca entre muestras, descontando lo que se mueve toda la
 *    cabeza (parche de los ojos). Solo cuenta mientras hay voz, si se sabe.
 * 3. Decidir a quién encuadrar: al grupo si cabe en el 9:16; si no, a quien habla (con histéresis
 *    para no rebotar); si nadie habla claro, a la cara más grande.
 * 4. Mover la "cámara" con suavidad: zona muerta, velocidad máxima, salto directo en cambios de
 *    escena o de persona, y nunca fuera de la imagen.
 */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Detection extends Box {
  /** Parche de la boca (grises, tamaño fijo) para medir si habla. */
  mouth?: Float32Array;
  /** Parche de los ojos: descuenta el movimiento de toda la cabeza o cambios de luz. */
  eyes?: Float32Array;
}

export interface Sample {
  /** Segundos desde el inicio del clip. */
  t: number;
  /** Hubo cambio de escena entre la muestra anterior y esta. */
  cut: boolean;
  detections: Detection[];
}

export interface Track {
  id: number;
  /** Detección de esta persona en cada muestra donde apareció. */
  seen: Map<number, Detection>;
}

export const FRAMING = {
  /** Muestras seguidas que una persona puede "desaparecer" sin perder su identidad (0.5 s). */
  maxGapSamples: 2,
  /** Una "persona" que dura menos de esto es casi siempre una detección falsa (1 s). */
  minTrackSamples: 4,
  /** Quién habla se decide con el promedio de la boca en esta ventana (histéresis natural). */
  switchSeconds: 1.5,
  /** Tras cambiar de persona, se queda al menos este tiempo (evita rebotes en diálogos rápidos). */
  holdSeconds: 2,
  /** Actividad mínima de la boca (diferencia media de grises) para considerar que habla. */
  minActivity: 3,
  /** Quien habla debe superar al segundo por este factor. */
  dominance: 1.3,
  /** El grupo se encuadra junto si cabe (con margen) en al menos esta fracción de las muestras. */
  groupFitFraction: 0.7,
  /** Margen a cada lado de una cara (pelo, hombros), en anchos de cara. */
  faceMargin: 0.3,
  /** Movimientos menores a esto (fracción del ancho del recorte) no mueven la cámara. */
  deadZone: 0.08,
  /** Velocidad máxima de paneo (anchos del recorte por segundo). */
  maxSpeed: 0.35,
  /** Si el objetivo queda más lejos que esto, se salta directo (cambio de persona). */
  jumpDistance: 0.4,
};

const center = (b: Box) => b.x + b.width / 2;

function overlap(a: Box, b: Box): number {
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const inter = w * h;
  return inter / (a.width * a.height + b.width * b.height - inter || 1);
}

/** Une las detecciones de la misma persona entre muestras. Un cambio de escena corta todo. */
export function buildTracks(samples: Sample[]): Track[] {
  const tracks: Track[] = [];
  let open: { track: Track; last: number; box: Detection }[] = [];
  samples.forEach((sample, k) => {
    if (sample.cut) open = [];
    open = open.filter((o) => k - o.last <= FRAMING.maxGapSamples + 1);
    // Pares posibles ordenados por distancia; se asignan de a uno (codicioso).
    const pairs: { o: number; d: number; dist: number }[] = [];
    open.forEach((o, oi) =>
      sample.detections.forEach((det, di) => {
        const dist = Math.hypot(center(det) - center(o.box), det.y + det.height / 2 - (o.box.y + o.box.height / 2));
        const size = Math.max(det.width, o.box.width);
        if (overlap(det, o.box) > 0.1 || dist < 0.6 * size) pairs.push({ o: oi, d: di, dist });
      }),
    );
    pairs.sort((a, b) => a.dist - b.dist);
    const usedO = new Set<number>();
    const usedD = new Set<number>();
    for (const p of pairs) {
      if (usedO.has(p.o) || usedD.has(p.d)) continue;
      usedO.add(p.o);
      usedD.add(p.d);
      const o = open[p.o]!;
      const det = sample.detections[p.d]!;
      o.track.seen.set(k, det);
      o.last = k;
      o.box = det;
    }
    sample.detections.forEach((det, di) => {
      if (usedD.has(di)) return;
      const track: Track = { id: tracks.length, seen: new Map([[k, det]]) };
      tracks.push(track);
      open.push({ track, last: k, box: det });
    });
  });
  return tracks.filter((t) => t.seen.size >= FRAMING.minTrackSamples);
}

function meanAbsDiff(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / a.length;
}

/** Cambio de la boca de una persona en cada muestra, descontando el movimiento de la cabeza. */
export function mouthActivity(track: Track): Map<number, number> {
  const raw = new Map<number, number>();
  for (const [k, det] of track.seen) {
    const prev = track.seen.get(k - 1);
    if (!prev?.mouth || !det.mouth || prev.mouth.length !== det.mouth.length) continue;
    const head = prev.eyes && det.eyes ? meanAbsDiff(prev.eyes, det.eyes) : 0;
    raw.set(k, Math.max(0, meanAbsDiff(prev.mouth, det.mouth) - head));
  }
  return raw;
}

/**
 * Caras visibles en la muestra k. Si alguna no se detectó, se usa su última caja reciente, pero
 * solo si no apareció nadie nuevo: si la cara "salta" a otro lugar sin detectarse el corte, la
 * posición vieja no debe seguir contando (crearía un grupo falso a mitad de camino).
 */
function heldBoxes(tracks: Track[], k: number): Detection[] {
  const seen = tracks.flatMap((t) => (t.seen.has(k) ? [t.seen.get(k)!] : []));
  const appeared = tracks.some((t) => t.seen.has(k) && !t.seen.has(k - 1) && Math.min(...t.seen.keys()) === k);
  if (appeared) return seen;
  return tracks.flatMap((t) => (boxAt(t, k) ? [boxAt(t, k)!] : []));
}

/** Caja de cada persona en la muestra k (o la última vista hace poco, si no se detectó). */
function boxAt(track: Track, k: number): Detection | undefined {
  for (let d = 0; d <= FRAMING.maxGapSamples; d++) {
    const det = track.seen.get(k - d);
    if (det) return det;
  }
  return undefined;
}

/**
 * Centro horizontal que debería tener el encuadre en cada muestra (null = no hay caras).
 * @param cropWidth ancho del recorte 9:16, en las mismas unidades que las cajas
 * @param frameWidth ancho de la imagen (para preferir caras centrales)
 * @param speaking si se sabe cuándo hay voz (transcripción), solo entonces cuenta la boca
 */
export function chooseTargets(
  samples: Sample[],
  tracks: Track[],
  cropWidth: number,
  frameWidth: number,
  sampleSeconds: number,
  speaking?: (t: number) => boolean,
): (number | null)[] {
  const targets: (number | null)[] = new Array(samples.length).fill(null);
  const activity = new Map(tracks.map((t) => [t.id, mouthActivity(t)]));
  const windowSamples = Math.max(1, Math.round(FRAMING.switchSeconds / sampleSeconds));
  const holdSamples = Math.round(FRAMING.holdSeconds / sampleSeconds);
  /** Promedio de la boca en la ventana que termina en k (sin dato = quieta). */
  const talking = (t: Track, k: number) => {
    const a = activity.get(t.id)!;
    let sum = 0;
    for (let i = k - windowSamples + 1; i <= k; i++) sum += a.get(i) ?? 0;
    return sum / windowSamples;
  };
  /** La cara más destacada: la más grande, y entre parecidas, la más central. */
  const prominence = (t: Track, k: number) => {
    const b = boxAt(t, k)!;
    return b.width * (1 - (0.3 * Math.abs(center(b) - frameWidth / 2)) / (frameWidth / 2));
  };

  for (const shot of shots(samples)) {
    const inShot = (t: Track) => [...t.seen.keys()].some((k) => k >= shot.start && k < shot.end);
    const shotTracks = tracks.filter(inShot);
    if (shotTracks.length === 0) continue;

    // ¿El grupo cabe junto en el 9:16 la mayor parte del tiempo?
    let withFaces = 0;
    let fits = 0;
    const groups: (Box | null)[] = [];
    for (let k = shot.start; k < shot.end; k++) {
      const boxes = heldBoxes(shotTracks, k);
      if (boxes.length === 0) {
        groups.push(null);
        continue;
      }
      const left = Math.min(...boxes.map((b) => b.x - FRAMING.faceMargin * b.width));
      const right = Math.max(...boxes.map((b) => b.x + b.width + FRAMING.faceMargin * b.width));
      groups.push({ x: left, y: 0, width: right - left, height: 0 });
      withFaces++;
      if (right - left <= cropWidth) fits++;
    }
    const groupMode = withFaces > 0 && fits / withFaces >= FRAMING.groupFitFraction;

    let current: Track | undefined;
    let switchedAt = -Infinity;
    for (let k = shot.start; k < shot.end; k++) {
      const group = groups[k - shot.start];
      if (!group) continue;
      if (groupMode) {
        targets[k] = center(group);
        continue;
      }
      const visible = heldBoxes(shotTracks, k);
      const present = shotTracks.filter((t) => visible.includes(boxAt(t, k)!));
      // Quién habla ahora: el que más mueve la boca en la ventana, si es claro.
      let talker: Track | undefined;
      if (!speaking || speaking(samples[k]!.t)) {
        const ranked = present.map((t) => ({ t, a: talking(t, k) })).sort((a, b) => b.a - a.a);
        const [first, second] = ranked;
        if (first && first.a >= FRAMING.minActivity && (!second || first.a >= FRAMING.dominance * second.a)) talker = first.t;
      }
      if (!current || !present.includes(current)) {
        current = talker ?? present.reduce((a, b) => (prominence(b, k) > prominence(a, k) ? b : a));
      } else if (talker && talker !== current && k - switchedAt >= holdSamples) {
        current = talker;
        switchedAt = k;
      }
      targets[k] = center(boxAt(current, k)!);
    }
  }
  return targets;
}

/** Tramos entre cambios de escena: [start, end). */
function shots(samples: Sample[]): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let start = 0;
  samples.forEach((s, k) => {
    if (k > 0 && s.cut) {
      out.push({ start, end: k });
      start = k;
    }
  });
  if (samples.length) out.push({ start, end: samples.length });
  return out;
}

/**
 * Posición de la "cámara" (centro del recorte) en cada muestra, lista para renderizar.
 * Dentro de cada escena: rellena huecos, quita temblores (mediana), sigue con zona muerta y
 * velocidad máxima, y salta directo si el objetivo está lejos. Nunca sale de la imagen.
 * @param fallback centro a usar en escenas sin ninguna cara
 */
export function smoothPath(
  samples: Sample[],
  targets: (number | null)[],
  cropWidth: number,
  frameWidth: number,
  sampleSeconds: number,
  fallback: number,
): number[] {
  const min = cropWidth / 2;
  const max = frameWidth - cropWidth / 2;
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const out: number[] = new Array(samples.length).fill(clamp(fallback));
  for (const shot of shots(samples)) {
    const values = targets.slice(shot.start, shot.end);
    if (values.every((v) => v === null)) continue; // sin caras: el encuadre por acción
    // Huecos: se mantiene la última posición conocida (y al inicio, la primera).
    const firstKnown = values.find((v) => v !== null)!;
    let last = firstKnown;
    const filled = values.map((v) => (v === null ? last : (last = v)));
    const median = filled.map((_, i) => {
      const w = filled.slice(Math.max(0, i - 2), i + 3).sort((a, b) => a - b);
      return w[Math.floor(w.length / 2)]!;
    });
    let cam = clamp(median[0]!);
    const dead = FRAMING.deadZone * cropWidth;
    const step = FRAMING.maxSpeed * cropWidth * sampleSeconds;
    median.forEach((target, i) => {
      const d = clamp(target) - cam;
      if (Math.abs(d) >= FRAMING.jumpDistance * cropWidth) cam = clamp(target);
      else if (Math.abs(d) > dead) cam += Math.sign(d) * Math.min(Math.abs(d) - dead, step);
      out[shot.start + i] = cam;
    });
  }
  return out;
}

/** Tramo de la trayectoria: la posición va de `from` a `to` entre `start` y `end` segundos. */
export interface PathPiece {
  start: number;
  end: number;
  from: number;
  to: number;
}

/**
 * Convierte las posiciones por muestra en tramos contiguos desde t=0 hasta el final:
 * líneas rectas simplificadas (tolerancia 1.5 px) y saltos directos cuando la posición cambia más
 * que `jump` entre dos muestras (el salto ocurre a mitad entre ambas).
 */
export function toPieces(times: number[], xs: number[], sampleSeconds: number, jump: number): PathPiece[] {
  if (xs.length === 0) return [];
  // Tramos continuos separados por saltos.
  const runs: { a: number; b: number; start: number; end: number }[] = [];
  let a = 0;
  let start = 0;
  for (let i = 1; i <= xs.length; i++) {
    if (i === xs.length || Math.abs(xs[i]! - xs[i - 1]!) >= jump) {
      const end = i === xs.length ? Infinity : times[i]! - sampleSeconds / 2;
      runs.push({ a, b: i - 1, start, end });
      a = i;
      start = end;
    }
  }
  const pieces: PathPiece[] = [];
  for (const run of runs) {
    const keep = new Set<number>([run.a, run.b]);
    const rdp = (from: number, to: number) => {
      let worst = -1;
      let worstDist = 1.5;
      for (let i = from + 1; i < to; i++) {
        const expected = xs[from]! + ((xs[to]! - xs[from]!) * (times[i]! - times[from]!)) / (times[to]! - times[from]! || 1);
        const dist = Math.abs(xs[i]! - expected);
        if (dist > worstDist) {
          worst = i;
          worstDist = dist;
        }
      }
      if (worst >= 0) {
        keep.add(worst);
        rdp(from, worst);
        rdp(worst, to);
      }
    };
    rdp(run.a, run.b);
    const idx = [...keep].sort((x, y) => x - y);
    const first = idx[0]!;
    const last = idx[idx.length - 1]!;
    if (run.start < times[first]!) pieces.push({ start: run.start, end: times[first]!, from: xs[first]!, to: xs[first]! });
    for (let i = 0; i + 1 < idx.length; i++) {
      pieces.push({ start: times[idx[i]!]!, end: times[idx[i + 1]!]!, from: xs[idx[i]!]!, to: xs[idx[i + 1]!]! });
    }
    const tail = Math.max(run.start, times[last]!);
    if (tail < run.end) pieces.push({ start: tail, end: run.end, from: xs[last]!, to: xs[last]! });
  }
  // Une tramos quietos seguidos en la misma posición.
  const merged: PathPiece[] = [];
  for (const p of pieces.filter((q) => q.end > q.start)) {
    const prev = merged[merged.length - 1];
    if (prev && prev.from === prev.to && p.from === p.to && prev.to === p.from && prev.end === p.start) prev.end = p.end;
    else merged.push({ ...p });
  }
  return merged;
}

/** Posición en el segundo t según los tramos. */
export function positionAt(pieces: PathPiece[], t: number): number {
  const p = pieces.find((q) => t >= q.start && t < q.end) ?? (t < (pieces[0]?.start ?? 0) ? pieces[0] : pieces[pieces.length - 1]);
  if (!p) return 0;
  if (!Number.isFinite(p.end) || p.end === p.start) return p.from;
  return p.from + ((p.to - p.from) * (t - p.start)) / (p.end - p.start);
}

/** Expresión de FFmpeg (variable t) que reproduce los tramos, para `crop=x='…'`. */
export function pathExpression(pieces: PathPiece[]): string {
  const n = (v: number) => (Math.round(v * 1000) / 1000).toString();
  return pieces
    .map((p) => {
      const range = Number.isFinite(p.end) ? `gte(t,${n(p.start)})*lt(t,${n(p.end)})` : `gte(t,${n(p.start)})`;
      const from = Math.round(p.from);
      const to = Math.round(p.to);
      const value =
        from === to || !Number.isFinite(p.end) ? `${from}` : `(${from}+${to - from}*(t-${n(p.start)})/${n(p.end - p.start)})`;
      return `${range}*${value}`;
    })
    .join("+");
}
