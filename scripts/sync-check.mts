/**
 * Chequeo de sincronía de subtítulos (lo corre el workflow "Diagnóstico"). Para los últimos trabajos:
 * - ¿dónde cae cada clip dentro del video original? (comparando la forma del sonido, no su contenido);
 * - ¿dónde lo ubicaba la transcripción? (la diferencia es lo que el subtítulo llega tarde o temprano);
 * - y, directo en el clip, el desfase entre "hay subtítulo" y "hay sonido".
 * Solo imprime números. Nunca imagen, sonido ni texto del video. Se ocultan ids y enlaces.
 */
import { spawn } from "node:child_process";
import { GetObjectCommand, ListObjectsV2Command, S3Client, type _Object } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const stage = process.env.STAGE ?? "staging";
const region = process.env.AWS_REGION ?? "us-east-1";
const bucket = `clipflow-${stage}-media-${process.env.AWS_ACCOUNT_ID}`;
const s3 = new S3Client({ region });
const RATE = 50; // valores de energía por segundo
const lines: string[] = [];
const out = (t = "") => {
  const safe = t.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>").replace(/https?:\/\/[^\s'"]+/g, "<enlace>");
  console.log(safe);
  lines.push(safe);
};

async function list(prefix: string): Promise<_Object[]> {
  const all: _Object[] = [];
  let token: string | undefined;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    all.push(...(r.Contents ?? []));
    token = r.NextContinuationToken;
  } while (token);
  return all;
}
const url = (key: string) => getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 3600 });
const text = async (key: string) => (await fetch(await url(key))).text();

/** Energía (dB) del audio, RATE valores por segundo. `sync`: como la transcripción actual (rellena huecos). */
function envelope(input: string, sync: boolean): Promise<Float32Array> {
  const args = ["-hide_banner", "-nostats", "-loglevel", "error", "-i", input, "-map", "0:a:0", "-vn"];
  if (sync) args.push("-af", "aresample=async=1:first_pts=0");
  args.push("-ac", "1", "-ar", "8000", "-f", "s16le", "-");
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const per = 8000 / RATE;
    const values: number[] = [];
    let acc = 0;
    let n = 0;
    let rest = Buffer.alloc(0);
    let err = "";
    child.stderr.on("data", (c: Buffer) => (err = (err + c).slice(-500)));
    child.stdout.on("data", (c: Buffer) => {
      const buf = rest.length ? Buffer.concat([rest, c]) : c;
      const usable = buf.length - (buf.length % 2);
      for (let i = 0; i < usable; i += 2) {
        const s = buf.readInt16LE(i) / 32768;
        acc += s * s;
        if (++n === per) {
          values.push(10 * Math.log10(acc / per + 1e-9));
          acc = 0;
          n = 0;
        }
      }
      rest = buf.subarray(usable);
    });
    child.on("close", (code) => (code === 0 ? resolve(Float32Array.from(values)) : reject(new Error(err.trim().split("\n").pop()))));
  });
}

/** Mejor desplazamiento (s) de `small` dentro de `big`, buscando entre `from` y `to` segundos. */
function locate(small: ArrayLike<number>, big: ArrayLike<number>, from: number, to: number) {
  const m = small.length;
  const meanS = Array.prototype.reduce.call(small, (a: number, b: number) => a + b, 0) as number / m;
  let sdS = 0;
  for (let i = 0; i < m; i++) sdS += (small[i]! - meanS) ** 2;
  let best = { at: NaN, score: -2 };
  for (let lag = Math.max(0, Math.round(from * RATE)); lag <= Math.min(big.length - m, Math.round(to * RATE)); lag++) {
    let mb = 0;
    for (let i = 0; i < m; i++) mb += big[lag + i]!;
    mb /= m;
    let num = 0;
    let sdB = 0;
    for (let i = 0; i < m; i++) {
      const d = big[lag + i]! - mb;
      num += (small[i]! - meanS) * d;
      sdB += d * d;
    }
    const score = num / Math.sqrt(sdS * sdB + 1e-12);
    if (score > best.score) best = { at: lag / RATE, score };
  }
  return best;
}

type Cue = { start: number; end: number; text: string };
function cues(vtt: string): Cue[] {
  const sec = (t: string) => t.split(":").reduce((a, x) => a * 60 + Number(x), 0);
  const res: Cue[] = [];
  for (const block of vtt.split(/\n\n+/)) {
    const m = /^([\d:.]+) --> ([\d:.]+)\n([\s\S]*)$/m.exec(block.trim());
    if (m) res.push({ start: sec(m[1]!), end: sec(m[2]!), text: m[3]!.trim() });
  }
  return res;
}

/** Desfase (s) entre "hay subtítulo" y "hay sonido fuerte": positivo = el subtítulo llega tarde. */
function cueLag(list: Cue[], env: Float32Array) {
  const sorted = Array.from(env).sort((a, b) => a - b);
  const loud = sorted[Math.floor(sorted.length * 0.4)]!;
  const speech = Array.from(env, (v) => (v > loud ? 1 : 0));
  const subs = new Array<number>(env.length).fill(0);
  for (const c of list) for (let i = Math.round(c.start * RATE); i < Math.min(env.length, c.end * RATE); i++) subs[i] = 1;
  let best = { lag: 0, score: -Infinity };
  for (let lag = -8 * RATE; lag <= 8 * RATE; lag++) {
    let s = 0;
    for (let i = 0; i < env.length; i++) {
      const j = i + lag;
      if (j >= 0 && j < env.length) s += (subs[j]! * 2 - 1) * (speech[i]! * 2 - 1);
    }
    if (s > best.score) best = { lag: lag / RATE, score: s };
  }
  return best.lag;
}

const fulls = (await list("subtitles/"))
  .filter((o) => o.Key!.endsWith("/full.vtt"))
  .sort((a, b) => +b.LastModified! - +a.LastModified!)
  .slice(0, Number(process.env.COUNT ?? 3));
const originals = await list("originals/");

out("# Sincronía de subtítulos (segundos; positivo = el subtítulo llega TARDE)");
for (const full of fulls) {
  const [, user, job] = full.Key!.split("/");
  out("");
  out(`## Trabajo del ${full.LastModified!.toISOString().slice(0, 16)} UTC`);
  try {
    const fullCues = cues(await text(full.Key!));
    const clipKeys = (await list(`clips/${user}/${job}/`)).filter((o) => o.Key!.endsWith(".mp4")).slice(0, 3);
    // El original de este trabajo: del mismo usuario, subido antes de la transcripción (el más cercano).
    const original = originals
      .filter((o) => o.Key!.split("/")[1] === user && +o.LastModified! <= +full.LastModified!)
      .sort((a, b) => +b.LastModified! - +a.LastModified!)[0];
    const origUrl = original ? await url(original.Key!) : null;
    const [envSync, envOld] = origUrl ? await Promise.all([envelope(origUrl, true), envelope(origUrl, false)]) : [null, null];
    if (envSync && envOld) {
      out(`- original: ${(envSync.length / RATE).toFixed(1)} s (con relleno) / ${(envOld.length / RATE).toFixed(1)} s (sin relleno)`);
      out(`- transcripción completa vs sonido del original: ${cueLag(fullCues, envSync).toFixed(2)} (con relleno), ${cueLag(fullCues, envOld).toFixed(2)} (sin relleno)`);
    } else out("- original: no encontrado");
    for (const clip of clipKeys) {
      const n = clip.Key!.split("/").pop()!.replace(".mp4", "");
      const clipCues = cues(await text(`subtitles/${user}/${job}/${n}.vtt`).catch(() => ""));
      const env = await envelope(await url(clip.Key!), false);
      const direct = clipCues.length ? cueLag(clipCues, env).toFixed(2) : "sin subtítulos";
      // Dónde decía la transcripción que empezaba el clip (misma frase en la transcripción completa).
      let expected = NaN;
      for (const c of clipCues.filter((c) => c.start > 0.3)) {
        const hit = fullCues.find((f) => f.text.trim() === c.text);
        if (hit) {
          expected = hit.start - c.start;
          break;
        }
      }
      let where = "";
      if (envSync && envOld && Number.isFinite(expected)) {
        const a = locate(env, envSync, expected - 60, expected + 60);
        const b = locate(env, envOld, expected - 60, expected + 60);
        where =
          ` · el clip está en ${a.at.toFixed(2)} (con relleno, parecido ${a.score.toFixed(2)}) / ${b.at.toFixed(2)} (sin relleno, ${b.score.toFixed(2)})` +
          ` · la transcripción lo ubicaba en ${expected.toFixed(2)} → desfase ${(a.at - expected).toFixed(2)}`;
      }
      out(`- clip ${n} (${(env.length / RATE).toFixed(1)} s): subtítulo vs sonido en el clip ${direct}${where}`);
    }
  } catch (err) {
    out(`- no se pudo revisar: ${String((err as Error).message ?? err).slice(-300)}`);
  }
}

const body = lines.join("\n");
const chunks = body.match(/[\s\S]{1,3500}/g) ?? [];
chunks.slice(0, 10).forEach((c, i) =>
  console.log(`::notice title=Sincronía ${i + 1}/${chunks.length}::${c.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}`),
);
