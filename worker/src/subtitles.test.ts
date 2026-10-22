import { describe, expect, it } from "vitest";
import { buildAss, timedWords } from "./subtitles.js";

const dialogues = (ass: string) => ass.split("\n").filter((l) => l.startsWith("Dialogue:"));

describe("subtítulos dibujados en el video (ASS)", () => {
  const segments = [
    {
      startSeconds: 0.2,
      endSeconds: 2,
      text: "y yo le digo: para",
      words: [
        { startSeconds: 0.2, endSeconds: 0.4, text: "y" },
        { startSeconds: 0.4, endSeconds: 0.6, text: "yo" },
        { startSeconds: 0.6, endSeconds: 0.8, text: "le" },
        { startSeconds: 0.8, endSeconds: 1.1, text: "digo:" },
        { startSeconds: 1.1, endSeconds: 1.6, text: "para" },
      ],
    },
  ];

  it("resaltado: de a pocas palabras en mayúsculas y la que suena en verde, con sus tiempos", () => {
    const lines = dialogues(buildAss(segments, "highlight", 30)!);
    expect(lines[0]).toBe("Dialogue: 0,0:00:00.20,0:00:00.40,Highlight,,0,0,0,,{\\c&H32F4C6&}Y{\\c&HFFFFFF&} YO LE");
    expect(lines[1]).toBe("Dialogue: 0,0:00:00.40,0:00:00.60,Highlight,,0,0,0,,Y {\\c&H32F4C6&}YO{\\c&HFFFFFF&} LE");
    // Máximo 3 palabras por grupo; después de ":" empieza otro grupo.
    expect(lines[3]).toContain("{\\c&H32F4C6&}DIGO:{\\c&HFFFFFF&}");
    expect(lines[3]).not.toContain("PARA");
    expect(lines.at(-1)).toBe("Dialogue: 0,0:00:01.10,0:00:01.60,Highlight,,0,0,0,,{\\c&H32F4C6&}PARA{\\c&HFFFFFF&}");
  });

  it("clásico: frases en una caja, sin cambiar mayúsculas", () => {
    const ass = buildAss(segments, "classic", 30)!;
    expect(ass).toContain("Style: Classic,Montserrat ExtraBold");
    const lines = dialogues(ass);
    expect(lines[0]).toBe("Dialogue: 0,0:00:00.20,0:00:01.10,Classic,,0,0,0,,y yo le digo:");
    expect(lines[1]).toBe("Dialogue: 0,0:00:01.10,0:00:01.60,Classic,,0,0,0,,para");
  });

  it("cada estilo trae solo su línea de estilo y eventos con ese nombre", () => {
    const names = { highlight: "Highlight", karaoke: "Karaoke", pop: "Pop", gamer: "Gamer", box: "Box", classic: "Classic", minimal: "Minimal" } as const;
    for (const [style, name] of Object.entries(names)) {
      const ass = buildAss(segments, style as keyof typeof names, 30)!;
      expect(ass.split("\n").filter((l) => l.startsWith("Style:"))).toEqual([expect.stringMatching(new RegExp(`^Style: ${name},Montserrat ExtraBold,`))]);
      expect(dialogues(ass).every((l) => l.includes(`,${name},,`))).toBe(true);
    }
  });

  it("karaoke: la palabra que suena en amarillo y con un «pop»; después vuelve al estilo normal", () => {
    const lines = dialogues(buildAss(segments, "karaoke", 30)!);
    expect(lines[1]).toBe(
      "Dialogue: 0,0:00:00.40,0:00:00.60,Karaoke,,0,0,0,,Y {\\c&H0AD6FF&\\fscx118\\fscy118\\t(0,100,\\fscx100\\fscy100)}YO{\\r} LE",
    );
  });

  it("pop: una sola palabra a la vez, en mayúsculas, que entra un poco más grande", () => {
    const lines = dialogues(buildAss(segments, "pop", 30)!);
    expect(lines).toHaveLength(5);
    expect(lines[3]).toBe("Dialogue: 0,0:00:00.80,0:00:01.10,Pop,,0,0,0,,{\\fscx125\\fscy125\\t(0,120,\\fscx100\\fscy100)}DIGO:");
  });

  it("gamer: inclinado y la palabra que suena en verde neón con borde verde oscuro", () => {
    const lines = dialogues(buildAss(segments, "gamer", 30)!);
    expect(lines[0]).toBe("Dialogue: 0,0:00:00.20,0:00:00.40,Gamer,,0,0,0,,{\\fax-0.18}{\\c&H80DE4A&\\3c&H1E4A14&}Y{\\r\\fax-0.18} YO LE");
  });

  it("caja: el grupo se va completando palabra por palabra", () => {
    const lines = dialogues(buildAss(segments, "box", 30)!);
    expect(lines.slice(0, 3).map((l) => l.split(",,0,0,0,,")[1])).toEqual(["Y", "Y YO", "Y YO LE"]);
  });

  it("minimal: frases cortas tal cual, sin caja", () => {
    const ass = buildAss(segments, "minimal", 30)!;
    expect(ass).toMatch(/Style: Minimal,Montserrat ExtraBold,58,[^\n]*,0,0,1,2\.5,1,2,/); // BorderStyle 1: sin caja
    expect(dialogues(ass)[0]).toBe("Dialogue: 0,0:00:00.20,0:00:01.10,Minimal,,0,0,0,,y yo le digo:");
  });

  it("sin tiempos por palabra los reparte según el largo de cada una", () => {
    const words = timedWords([{ startSeconds: 10, endSeconds: 13, text: "uno dos tres" }], 60);
    expect(words.map((w) => w.text)).toEqual(["uno", "dos", "tres"]);
    expect(words[0]!.startSeconds).toBe(10);
    expect(words[2]!.endSeconds).toBeCloseTo(13);
    expect(words[1]!.startSeconds).toBeCloseTo(words[0]!.endSeconds);
  });

  it("no deja huecos cortos (parpadeos) pero sí pausas largas", () => {
    const lines = dialogues(
      buildAss(
        [
          { startSeconds: 0, endSeconds: 1, text: "hola.", words: [{ startSeconds: 0, endSeconds: 1, text: "hola." }] },
          { startSeconds: 1.2, endSeconds: 2, text: "sigo", words: [{ startSeconds: 1.2, endSeconds: 2, text: "sigo" }] },
          { startSeconds: 5, endSeconds: 6, text: "fin", words: [{ startSeconds: 5, endSeconds: 6, text: "fin" }] },
        ],
        "highlight",
        30,
      )!,
    );
    expect(lines[0]).toContain("0:00:00.00,0:00:01.20"); // se estira hasta la siguiente
    expect(lines[1]).toContain("0:00:01.20,0:00:02.00"); // pausa de 3 s: no se estira
  });

  it("el texto no puede inyectar comandos de ASS y nada pasa del final del clip", () => {
    const ass = buildAss([{ startSeconds: 0, endSeconds: 9, text: "{\\b1}hola\\N" }], "classic", 5)!;
    const [line] = dialogues(ass);
    expect(line).toBe("Dialogue: 0,0:00:00.00,0:00:05.00,Classic,,0,0,0,,/b1hola/N");
    expect(line!.split(",,").at(-1)).not.toMatch(/[{}\\]/);
  });

  it("sin palabras no genera nada", () => {
    expect(buildAss([], "highlight", 30)).toBeNull();
    expect(buildAss([{ startSeconds: 0, endSeconds: 1, text: "   " }], "classic", 30)).toBeNull();
  });
});
