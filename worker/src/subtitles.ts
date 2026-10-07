import { fileURLToPath } from "node:url";
import type { SubtitleStyle, TranscriptSegment, TranscriptWord } from "@clipflow/shared";

/**
 * Subtítulos "quemados" en el video (formato ASS, los dibuja FFmpeg con libass).
 *
 * - "highlight": de a 1–3 palabras en MAYÚSCULAS, la que suena en verde lima (estilo TikTok).
 *   Usa el tiempo de cada palabra de Whisper; si no lo hay, lo reparte según el largo de cada una.
 * - "classic": frases cortas en una caja oscura, en mayúsculas y minúsculas.
 *
 * El video final mide 1080x1920; el texto queda en la parte baja de la imagen central.
 */

/** Carpeta con la fuente Montserrat ExtraBold (licencia OFL, ver fonts/OFL-Montserrat.txt). */
export const SUBTITLE_FONTS_DIR = fileURLToPath(new URL("../fonts/", import.meta.url));
const FONT = "Montserrat ExtraBold";
/** Verde de ClipFlow (#c6f432) en el formato de color de ASS (&HBBGGRR). */
const LIME = "&H32F4C6&";
const WHITE = "&HFFFFFF&";
/** Distancia del texto al borde inferior (px de un video de 1920 de alto). */
const MARGIN_V = 470;

const HIGHLIGHT_MAX_WORDS = 3;
const HIGHLIGHT_MAX_CHARS = 16;
const CLASSIC_MAX_CHARS = 52;
/** Pausas más largas que esto cortan el grupo de palabras. */
const GAP_BREAK_SECONDS = 0.5;
/** Pausas más cortas que esto no dejan la pantalla vacía (evita parpadeos). */
const GAP_FILL_SECONDS = 0.4;

/** Archivo ASS listo para FFmpeg, o null si no hay nada que mostrar. */
export function buildAss(
  segments: TranscriptSegment[],
  style: Exclude<SubtitleStyle, "none">,
  clipDurationSeconds: number,
): string | null {
  const words = timedWords(segments, clipDurationSeconds);
  if (words.length === 0) return null;
  const events = style === "highlight" ? highlightEvents(words, clipDurationSeconds) : classicEvents(words, clipDurationSeconds);
  if (events.length === 0) return null;
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1080",
    "PlayResY: 1920",
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    // Resaltado: letras grandes con borde negro grueso y una sombra suave.
    `Style: Highlight,${FONT},86,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,1,0,1,7,3,2,80,80,${MARGIN_V},1`,
    // Clásico: caja negra semitransparente detrás del texto (BorderStyle 3).
    `Style: Classic,${FONT},64,&H00FFFFFF,&H00FFFFFF,&H5A000000,&H00000000,0,0,0,0,100,100,0,0,3,16,0,2,110,110,${MARGIN_V},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events.map((e) => `Dialogue: 0,${assTime(e.start)},${assTime(e.end)},${e.style},,0,0,0,,${e.text}`),
    "",
  ].join("\n");
}

interface AssEvent {
  start: number;
  end: number;
  style: "Highlight" | "Classic";
  text: string;
}

/** Palabras con tiempo dentro del clip: las de Whisper o, si faltan, repartidas por largo. */
export function timedWords(segments: TranscriptSegment[], clipDurationSeconds: number): TranscriptWord[] {
  const out: TranscriptWord[] = [];
  for (const segment of segments) {
    const words = segment.words?.length ? segment.words : spreadWords(segment);
    for (const w of words) {
      const text = clean(w.text);
      const start = Math.max(0, w.startSeconds);
      const end = Math.min(clipDurationSeconds, Math.max(w.endSeconds, start + 0.05));
      if (text && end > start) out.push({ startSeconds: start, endSeconds: end, text });
    }
  }
  return out.sort((a, b) => a.startSeconds - b.startSeconds);
}

function spreadWords(segment: TranscriptSegment): TranscriptWord[] {
  const tokens = segment.text.split(/\s+/).filter(Boolean);
  const total = tokens.reduce((sum, t) => sum + t.length + 1, 0);
  const span = segment.endSeconds - segment.startSeconds;
  let t = segment.startSeconds;
  return tokens.map((text) => {
    const d = (span * (text.length + 1)) / total;
    const w = { startSeconds: t, endSeconds: t + d, text };
    t += d;
    return w;
  });
}

/** Agrupa palabras: corta por cantidad, largo, puntuación o pausa. */
function group(words: TranscriptWord[], maxWords: number, maxChars: number): TranscriptWord[][] {
  const groups: TranscriptWord[][] = [];
  let current: TranscriptWord[] = [];
  for (const w of words) {
    const prev = current[current.length - 1];
    const chars = current.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length;
    const breakHere =
      prev &&
      (current.length >= maxWords ||
        chars > maxChars ||
        /[.!?…,;:]$/.test(prev.text) ||
        w.startSeconds - prev.endSeconds > GAP_BREAK_SECONDS);
    if (breakHere) {
      groups.push(current);
      current = [];
    }
    current.push(w);
  }
  if (current.length) groups.push(current);
  return groups;
}

/** Fin visible de cada grupo: si el siguiente empieza enseguida, se llega hasta él. */
function groupEnds(groups: TranscriptWord[][], clipDurationSeconds: number): number[] {
  return groups.map((g, i) => {
    const end = g[g.length - 1]!.endSeconds;
    const next = groups[i + 1]?.[0]?.startSeconds;
    const filled = next !== undefined && next - end < GAP_FILL_SECONDS ? next : end;
    return Math.min(clipDurationSeconds, filled);
  });
}

function highlightEvents(words: TranscriptWord[], clipDurationSeconds: number): AssEvent[] {
  const groups = group(words, HIGHLIGHT_MAX_WORDS, HIGHLIGHT_MAX_CHARS);
  const ends = groupEnds(groups, clipDurationSeconds);
  const events: AssEvent[] = [];
  groups.forEach((g, gi) => {
    const upper = g.map((w) => w.text.toLocaleUpperCase());
    g.forEach((w, i) => {
      const start = w.startSeconds;
      const end = i === g.length - 1 ? ends[gi]! : g[i + 1]!.startSeconds;
      if (end - start < 0.02) return;
      const text = upper.map((t, j) => (j === i ? `{\\c${LIME}}${t}{\\c${WHITE}}` : t)).join(" ");
      events.push({ start, end, style: "Highlight", text });
    });
  });
  return events;
}

function classicEvents(words: TranscriptWord[], clipDurationSeconds: number): AssEvent[] {
  const groups = group(words, Number.POSITIVE_INFINITY, CLASSIC_MAX_CHARS);
  const ends = groupEnds(groups, clipDurationSeconds);
  return groups
    .map((g, i) => ({ start: g[0]!.startSeconds, end: ends[i]!, style: "Classic" as const, text: g.map((w) => w.text).join(" ") }))
    .filter((e) => e.end - e.start >= 0.02);
}

/** Quita lo que ASS interpretaría como comandos ({…} y \) y los saltos de línea. */
function clean(text: string): string {
  return text.replace(/[{}]/g, "").replace(/\\/g, "/").replace(/\s+/g, " ").trim();
}

/** Tiempo de ASS: H:MM:SS.cc */
function assTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}
