import { describe, expect, it } from "vitest";
import { planUploadParts, resolveVideoMimeType } from "./validation.js";

const ALLOWED = ["video/mp4", "video/quicktime", "video/webm", "video/x-matroska"];

describe("resolveVideoMimeType", () => {
  it("acepta formatos de video conocidos", () => {
    expect(resolveVideoMimeType("clase.MP4", "video/mp4", ALLOWED)).toBe("video/mp4");
    expect(resolveVideoMimeType("a.mov", "video/quicktime", ALLOWED)).toBe("video/quicktime");
    expect(resolveVideoMimeType("a.mkv", "", ALLOWED)).toBe("video/x-matroska");
  });

  it("rechaza extensiones o tipos que no son video", () => {
    expect(resolveVideoMimeType("virus.exe", "application/x-msdownload", ALLOWED)).toBeNull();
    expect(resolveVideoMimeType("foto.jpg", "image/jpeg", ALLOWED)).toBeNull();
    expect(resolveVideoMimeType("sin-extension", "video/mp4", ALLOWED)).toBeNull();
  });

  it("rechaza si la extensión y el tipo no coinciden", () => {
    expect(resolveVideoMimeType("truco.mp4", "text/html", ALLOWED)).toBeNull();
    expect(resolveVideoMimeType("a.mp4", "video/webm", ALLOWED)).toBeNull();
  });

  it("respeta la lista de tipos permitidos", () => {
    expect(resolveVideoMimeType("a.webm", "video/webm", ["video/mp4"])).toBeNull();
  });
});

describe("planUploadParts", () => {
  const MiB = 1024 * 1024;
  it("usa partes de 16 MiB para archivos normales", () => {
    expect(planUploadParts(100 * MiB)).toEqual({ partSizeBytes: 16 * MiB, partCount: 7 });
    expect(planUploadParts(1)).toEqual({ partSizeBytes: 16 * MiB, partCount: 1 });
  });

  it("nunca supera el límite de 10.000 partes de S3", () => {
    const huge = 500 * 1024 * MiB; // 500 GiB
    const plan = planUploadParts(huge);
    expect(plan.partCount).toBeLessThanOrEqual(10_000);
    expect(plan.partSizeBytes * plan.partCount).toBeGreaterThanOrEqual(huge);
  });
});
