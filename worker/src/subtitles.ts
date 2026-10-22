import { fileURLToPath } from "node:url";
import type { SubtitleStyle, TranscriptSegment, TranscriptWord } from "@clipflow/shared";

/**
 * Subtítulos "quemados" en el video (formato ASS, los dibuja FFmpeg con libass, en la misma pasada que
 * recorta el clip: ningún estilo agrega tiempo de procesamiento).
 *
 * Palabra por palabra (usan el tiempo de cada palabra de la transcripción; si no lo hay, lo reparten
 * según el largo de cada una):
 * - "highlight": de a 1–3 palabras en MAYÚSCULAS, la que suena en verde lima (estilo TikTok).
 * - "karaoke": igual, la que suena en amarillo y un poco más grande («pop»), en el tercio inferior.
 * - "pop": UNA palabra a la vez, muy grande, con sombra naranja y un pequeño salto al aparecer.
 * - "gamer": de a 1–3 palabras inclinadas, la que suena en verde neón.
 * - "box": texto negro en una caja amarilla que se va completando palabra por palabra.
 * Por frases:
 * - "classic": frases cortas en una caja oscura, en mayúsculas y minúsculas.
 * - "minimal": frases cortas, letra más chica, sin caja (discreto).
 *
 * El video final mide 1080x1920.
 */

/** Carpeta con la fuente Montserrat ExtraBold (licencia OFL, ver fonts/OFL-Montserrat.txt). */
export const SUBTITLE_FONTS_DIR = fileURLToPath(new URL("../fonts/", import.meta.url));
const FONT = "Montserrat ExtraBold";
/** Colores en el formato de ASS (&HBBGGRR). Verde de ClipFlow (#c6f432). */
const LIME = "&H32F4C6&";
const WHITE = "&HFFFFFF&";
/** Amarillo (#ffd60a) y verde neón (#4ade80). */
const YELLOW = "&H0AD6FF&";
const NEON = "&H80DE4A&";
/** Distancia del texto al borde inferior (px de un video de 1920 de alto). */
const MARGIN_V = 470;

const HIGHLIGHT_MAX_WORDS = 3;
const HIGHLIGHT_MAX_CHARS = 16;
const CLASSIC_MAX_CHARS = 52;
const MINIMAL_MAX_CHARS = 36;
/** Pausas más largas que esto cortan el grupo de palabras. */
const GAP_BREAK_SECONDS = 0.5;
/** Pausas más cortas que esto no dejan la pantalla vacía (evita parpadeos). */
const GAP_FILL_SECONDS = 0.4;

type BurnStyle = Exclude<SubtitleStyle, "none">;

/** Nombre del estilo en el archivo ASS y su línea «Style:». */
const STYLE_LINES: Record<BurnStyle, { name: AssEvent["style"]; line: string }> = {
  // Resaltado: letras grandes con borde negro grueso y una sombra suave.
  highlight: { name: "Highlight", line: `${FONT},86,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,1,0,1,7,3,2,80,80,${MARGIN_V},1` },
  // Clásico: caja negra semitransparente detrás del texto (BorderStyle 3).
  classic: { name: "Classic", line: `${FONT},64,&H00FFFFFF,&H00FFFFFF,&H5A000000,&H00000000,0,0,0,0,100,100,0,0,3,16,0,2,110,110,${MARGIN_V},1` },
  // Karaoke: más grande, borde negro grueso, en el tercio inferior.
  karaoke: { name: "Karaoke", line: `${FONT},96,&H00FFFFFF,&H00FFFFFF,&H00000000,&H78000000,-1,0,0,0,100,100,1,0,1,9,4,2,70,70,430,1` },
  // Pop: una palabra enorme, borde negro y sombra naranja (#ff5a1f) desplazada.
  pop: { name: "Pop", line: `${FONT},124,&H00FFFFFF,&H00FFFFFF,&H00000000,&H001F5AFF,-1,0,0,0,100,100,2,0,1,8,7,2,60,60,${MARGIN_V},1` },
  // Gamer: letras inclinadas con borde oscuro, separación amplia.
  gamer: { name: "Gamer", line: `${FONT},84,&H00FFFFFF,&H00FFFFFF,&H00101010,&H96000000,-1,0,0,0,100,100,3,0,1,6,3,2,80,80,${MARGIN_V},1` },
  // Minimal: chico, sin caja, borde fino.
  minimal: { name: "Minimal", line: `${FONT},58,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2.5,1,2,120,120,380,1` },
  // Caja: texto negro sobre caja amarilla (con BorderStyle 3 el color de la caja es OutlineColour).
  box: { name: "Box", line: `${FONT},78,&H00101010,&H00101010,&H000AD6FF,&H00000000,-1,0,0,0,100,100,1,0,3,14,0,2,90,90,${MARGIN_V},1` },
};

/** Archivo ASS listo para FFmpeg, o null si no hay nada que mostrar. */
export function buildAss(segments: TranscriptSegment[], style: BurnStyle, clipDurationSeconds: number): string | null {
  const words = timedWords(segments, clipDurationSeconds);
  if (words.length === 0) return null;
  const events = styleEvents(style, words, clipDurationSeconds);
  if (events.length === 0) return null;
  const { name, line } = STYLE_LINES[style] ?? STYLE_LINES.highlight;
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
    `Style: ${name},${line}`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events.map((e) => `Dialogue: 0,${assTime(e.start)},${assTime(e.end)},${e.style},,0,0,0,,${e.text}`),
    "",
  ].join("\n");
}

function styleEvents(style: BurnStyle, words: TranscriptWord[], duration: number): AssEvent[] {
  switch (style) {
    case "classic":
      return phraseEvents(words, duration, CLASSIC_MAX_CHARS, "Classic");
    case "minimal":
      return phraseEvents(words, duration, MINIMAL_MAX_CHARS, "Minimal");
    case "karaoke":
      return highlightEvents(words, duration, { color: YELLOW, style: "Karaoke", pop: "\\fscx118\\fscy118\\t(0,100,\\fscx100\\fscy100)" });
    case "gamer":
      // Inclinado (\fax) y la palabra que suena en verde neón con un borde verde oscuro.
      return highlightEvents(words, duration, { color: NEON, style: "Gamer", prefix: "{\\fax-0.18}", outline: "&H1E4A14&" });
    case "pop":
      return popEvents(words, duration);
    case "box":
      return boxEvents(words, duration);
    default:
      return highlightEvents(words, duration);
  }
}

interface AssEvent {
  start: number;
  end: number;
  style: "Highlight" | "Classic" | "Karaoke" | "Pop" | "Gamer" | "Minimal" | "Box";
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

function highlightEvents(
  words: TranscriptWord[],
  clipDurationSeconds: number,
  look: { color: string; style: AssEvent["style"]; pop?: string; prefix?: string; outline?: string } = { color: LIME, style: "Highlight" },
): AssEvent[] {
  const groups = group(words, HIGHLIGHT_MAX_WORDS, HIGHLIGHT_MAX_CHARS);
  const ends = groupEnds(groups, clipDurationSeconds);
  const events: AssEvent[] = [];
  // Lo que se cambia en la palabra que suena, y cómo se vuelve al estilo normal después.
  const on = `\\c${look.color}${look.outline ? `\\3c${look.outline}` : ""}${look.pop ?? ""}`;
  const off = look.outline || look.pop ? `{\\r${look.prefix ? look.prefix.slice(1, -1) : ""}}` : `{\\c${WHITE}}`;
  groups.forEach((g, gi) => {
    const upper = g.map((w) => w.text.toLocaleUpperCase());
    g.forEach((w, i) => {
      const start = w.startSeconds;
      const end = i === g.length - 1 ? ends[gi]! : g[i + 1]!.startSeconds;
      if (end - start < 0.02) return;
      const text = upper.map((t, j) => (j === i ? `{${on}}${t}${off}` : t)).join(" ");
      events.push({ start, end, style: look.style, text: `${look.prefix ?? ""}${text}` });
    });
  });
  return events;
}

/** Pop: una palabra a la vez que aparece un poco más grande y se acomoda en 0.12 s. */
function popEvents(words: TranscriptWord[], clipDurationSeconds: number): AssEvent[] {
  const groups = words.map((w) => [w]);
  const ends = groupEnds(groups, clipDurationSeconds);
  return words
    .map((w, i) => ({
      start: w.startSeconds,
      end: ends[i]!,
      style: "Pop" as const,
      text: `{\\fscx125\\fscy125\\t(0,120,\\fscx100\\fscy100)}${w.text.toLocaleUpperCase()}`,
    }))
    .filter((e) => e.end - e.start >= 0.02);
}

/** Caja: el grupo se va completando palabra por palabra dentro de la caja amarilla. */
function boxEvents(words: TranscriptWord[], clipDurationSeconds: number): AssEvent[] {
  const groups = group(words, HIGHLIGHT_MAX_WORDS, HIGHLIGHT_MAX_CHARS);
  const ends = groupEnds(groups, clipDurationSeconds);
  const events: AssEvent[] = [];
  groups.forEach((g, gi) => {
    g.forEach((w, i) => {
      const end = i === g.length - 1 ? ends[gi]! : g[i + 1]!.startSeconds;
      if (end - w.startSeconds < 0.02) return;
      const text = g.slice(0, i + 1).map((x) => x.text.toLocaleUpperCase()).join(" ");
      events.push({ start: w.startSeconds, end, style: "Box", text });
    });
  });
  return events;
}

/** Frases (clásico y minimal): grupos por largo, en mayúsculas y minúsculas. */
function phraseEvents(
  words: TranscriptWord[],
  clipDurationSeconds: number,
  maxChars: number,
  style: AssEvent["style"],
): AssEvent[] {
  const groups = group(words, Number.POSITIVE_INFINITY, maxChars);
  const ends = groupEnds(groups, clipDurationSeconds);
  return groups
    .map((g, i) => ({ start: g[0]!.startSeconds, end: ends[i]!, style, text: g.map((w) => w.text).join(" ") }))
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
