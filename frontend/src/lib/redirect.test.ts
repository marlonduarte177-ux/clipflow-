import { describe, expect, it } from "vitest";
import { safeNextPath } from "./redirect";

describe("safeNextPath", () => {
  it("acepta rutas internas", () => {
    expect(safeNextPath("/dashboard/proyectos")).toBe("/dashboard/proyectos");
  });

  it("usa /dashboard si no hay valor", () => {
    expect(safeNextPath(null)).toBe("/dashboard");
    expect(safeNextPath("")).toBe("/dashboard");
  });

  it("rechaza redirecciones a otros sitios", () => {
    expect(safeNextPath("https://malicioso.example")).toBe("/dashboard");
    expect(safeNextPath("//malicioso.example")).toBe("/dashboard");
    expect(safeNextPath("/\\malicioso.example")).toBe("/dashboard");
    expect(safeNextPath("javascript:alert(1)")).toBe("/dashboard");
  });
});
