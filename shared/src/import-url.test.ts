import { describe, expect, it } from "vitest";
import { checkImportUrl, ImportVideoSchema, isPrivateAddress } from "./validation.js";

describe("enlaces para importar videos", () => {
  it("acepta enlaces públicos http(s) y quita el #fragmento", () => {
    expect(checkImportUrl(" https://www.youtube.com/watch?v=abc#t=10 ")).toEqual({ ok: true, url: "https://www.youtube.com/watch?v=abc" });
    expect(checkImportUrl("http://example.com/video.mp4")).toMatchObject({ ok: true });
  });

  it("rechaza otros protocolos, credenciales y texto que no es un enlace", () => {
    for (const bad of ["ftp://example.com/a.mp4", "file:///etc/passwd", "javascript:alert(1)", "hola", "https://user:pass@example.com/a.mp4", "https://intranet/a.mp4"]) {
      expect(checkImportUrl(bad).ok, bad).toBe(false);
    }
  });

  it("rechaza direcciones internas, también escritas de formas raras", () => {
    for (const bad of [
      "http://localhost:8080/x",
      "http://127.0.0.1/x",
      "http://2130706433/x", // 127.0.0.1 como número
      "http://0x7f.0.0.1/x",
      "http://169.254.169.254/latest/meta-data/", // metadatos de la nube
      "http://169.254.170.2/v2/credentials", // credenciales de ECS
      "http://10.0.0.5/x",
      "http://192.168.1.1/x",
      "http://[::1]/x",
      "http://[fd00:ec2::254]/x",
      "http://[::ffff:127.0.0.1]/x",
      "http://metadata.google.internal/x",
    ]) {
      expect(checkImportUrl(bad).ok, bad).toBe(false);
    }
  });

  it("clasifica bien las IPs públicas y privadas", () => {
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("172.32.0.1")).toBe(false);
    expect(isPrivateAddress("172.16.0.1")).toBe(true);
    expect(isPrivateAddress("100.64.0.1")).toBe(true);
    expect(isPrivateAddress("2606:4700::1111")).toBe(false);
    expect(isPrivateAddress("fe80::1")).toBe(true);
  });

  it("exige confirmar los derechos sobre el video", () => {
    const base = { projectId: "0b7c2f4e-8a0e-4f7a-9d9e-1f2a3b4c5d6e", url: "https://example.com/v.mp4" };
    expect(ImportVideoSchema.safeParse(base).success).toBe(false);
    expect(ImportVideoSchema.safeParse({ ...base, rightsConfirmed: false }).success).toBe(false);
    expect(ImportVideoSchema.safeParse({ ...base, rightsConfirmed: true }).success).toBe(true);
  });
});
