import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { detectFaces } from "./yunet.js";

const fixture = fileURLToPath(new URL("../../test-fixtures/nasa-crew.jpg", import.meta.url));

/** Decodifica la foto de prueba a BGR con el ancho pedido. */
function bgr(width: number) {
  const out = execFileSync("ffmpeg", ["-loglevel", "error", "-i", path.resolve(fixture), "-vf", `scale=${width}:-2`, "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]);
  return { pixels: new Uint8Array(out), width, height: out.length / 3 / width };
}

describe("detector de caras YuNet", () => {
  it("encuentra a las 6 personas de la foto, en orden y con sus puntos de la cara", async () => {
    const img = bgr(640);
    const faces = (await detectFaces(img.pixels, img.width, img.height)).sort((a, b) => a.x - b.x);
    expect(faces).toHaveLength(6);
    for (const [i, face] of faces.entries()) {
      // Una persona por cada sexto del ancho.
      const center = face.x + face.width / 2;
      expect(center).toBeGreaterThan((i * 640) / 6);
      expect(center).toBeLessThan(((i + 1) * 640) / 6);
      expect(face.score).toBeGreaterThan(0.8);
      const [rightEye, leftEye, nose, mouthRight, mouthLeft] = face.landmarks;
      expect(rightEye![1]).toBeLessThan(nose![1]); // ojos arriba de la nariz
      expect(nose![1]).toBeLessThan(mouthRight![1]); // nariz arriba de la boca
      expect(mouthLeft![0]).toBeGreaterThan(mouthRight![0]);
      expect(leftEye![0]).toBeGreaterThan(rightEye![0]);
    }
  });

  it("también a 320 px de ancho (el tamaño que usa el encuadre)", async () => {
    const img = bgr(320);
    expect(await detectFaces(img.pixels, img.width, img.height)).toHaveLength(6);
  });

  it("no inventa caras en una imagen sin personas", async () => {
    const out = execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]);
    expect(await detectFaces(new Uint8Array(out), 640, 360)).toEqual([]);
  });
});
