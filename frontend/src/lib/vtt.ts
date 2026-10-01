/** Una frase de la transcripción con sus tiempos (segundos). */
export interface Cue {
  start: number;
  end: number;
  text: string;
}

function toSeconds(stamp: string): number {
  const parts = stamp.trim().split(":").map(Number);
  return parts.reduce((total, n) => total * 60 + n, 0);
}

/** Lee un archivo WebVTT (el que genera el worker) y devuelve sus frases. */
export function parseVtt(text: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of text.replace(/\r/g, "").split(/\n{2,}/)) {
    const lines = block.split("\n");
    const timing = lines.findIndex((l) => l.includes("-->"));
    if (timing < 0) continue;
    const [from, to] = lines[timing]!.split("-->");
    const start = toSeconds(from!);
    const end = toSeconds(to!.trim().split(/\s+/)[0]!);
    const body = lines.slice(timing + 1).join(" ").trim();
    if (body && Number.isFinite(start) && Number.isFinite(end)) cues.push({ start, end, text: body });
  }
  return cues;
}

/** 75 → "1:15"; 3725 → "1:02:05". */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${rest}` : `${m}:${rest}`;
}
