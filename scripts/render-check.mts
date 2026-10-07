/**
 * Chequeo del recorte (lo corre el workflow "Diagnóstico", dentro de la misma imagen que el procesador:
 * Debian 12 + FFmpeg 5.1). Sobre los últimos videos originales del bucket hace lo mismo que el
 * procesador con un clip de 20 s: medir, detectar franjas, elegir el encuadre (con caras) y generar
 * el clip vertical. Solo imprime medidas, el encuadre y, si falla, el mensaje de FFmpeg.
 * Nunca imprime imagen, sonido ni texto del video. El repositorio es público: se ocultan ids y enlaces.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { chooseVerticalCrop, detectContentBox, probe, renderThumbnail, renderVerticalClip } from "../worker/src/ffmpeg.ts";

const stage = process.env.STAGE ?? "staging";
const region = process.env.AWS_REGION ?? "us-east-1";
const tools = { ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" };
const lines: string[] = [];
const redact = (t: string) =>
  t
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\b\d{12}\b/g, "<cuenta>")
    .replace(/https?:\/\/[^\s'"]+/g, "<enlace>");
const out = (t = "") => {
  const safe = redact(t);
  console.log(safe);
  lines.push(safe);
};

const bucket = `clipflow-${stage}-media-${process.env.AWS_ACCOUNT_ID}`;
const s3 = new S3Client({ region });
const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: "originals/", MaxKeys: 1000 }));
const newest = (listed.Contents ?? []).sort((a, b) => +b.LastModified! - +a.LastModified!).slice(0, Number(process.env.COUNT ?? 4));

out(`# Chequeo del recorte (FFmpeg de la imagen del procesador)`);
for (const obj of newest) {
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: obj.Key! }), { expiresIn: 1800 });
  out("");
  try {
    const info = await probe(tools, url);
    out(`- video: ${info.width}x${info.height} ${info.videoCodec} ${info.pixelFormat} ${Math.round(info.durationSeconds)} s`);
    const box = await detectContentBox(tools, url, info);
    out(`  franjas: ${box ? JSON.stringify(box) : "ninguna"}`);
    const segment = { startSeconds: Math.max(0, info.durationSeconds * 0.3), durationSeconds: Math.min(20, info.durationSeconds) };
    const dir = mkdtempSync(path.join(tmpdir(), "check-"));
    for (const faces of [true, false]) {
      try {
        const crop = await chooseVerticalCrop(tools, url, info, box, segment, undefined, {
          faces,
          onWarning: (m, e) => out(`  aviso (${faces ? "con caras" : "sin caras"}): ${m}: ${String((e as { stderrTail?: string }).stderrTail ?? e).slice(-400)}`),
        });
        const { path: pieces, ...rest } = crop;
        out(`  encuadre ${faces ? "con caras" : "sin caras"}: ${JSON.stringify(rest)}${pieces ? ` (${pieces.length} tramos)` : ""}`);
        await renderVerticalClip(tools, url, path.join(dir, `clip-${faces}.mp4`), segment, { crop });
        await renderThumbnail(tools, url, path.join(dir, `thumb-${faces}.jpg`), segment.startSeconds + 5, undefined, crop);
        out(`  clip ${faces ? "con caras" : "sin caras"}: OK`);
      } catch (err) {
        out(`  clip ${faces ? "con caras" : "sin caras"}: FALLA → ${String((err as { stderrTail?: string }).stderrTail ?? err).slice(-600)}`);
      }
    }
  } catch (err) {
    out(`- no se pudo revisar: ${String((err as { stderrTail?: string }).stderrTail ?? err).slice(-300)}`);
  }
}

const text = lines.join("\n");
const chunks = text.match(/[\s\S]{1,3500}/g) ?? [];
chunks.slice(0, 10).forEach((c, i) =>
  console.log(`::notice title=Recorte ${i + 1}/${chunks.length}::${c.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}`),
);
