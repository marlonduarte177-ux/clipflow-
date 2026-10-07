import { describe, expect, it } from "vitest";
import { parseClock } from "./clock-input";

describe("tiempos escritos por el usuario", () => {
  it("entiende h:mm:ss, mm:ss, segundos y 1h30m", () => {
    expect(parseClock("1:30:00")).toBe(5400);
    expect(parseClock(" 45:10 ")).toBe(2710);
    expect(parseClock("90")).toBe(90);
    expect(parseClock("1h30m")).toBe(5400);
    expect(parseClock("2h")).toBe(7200);
    expect(parseClock("")).toBeNull();
  });

  it("marca lo que no se entiende", () => {
    expect(parseClock("1:75")).toBeNaN();
    expect(parseClock("1:2:3:4")).toBeNaN();
    expect(parseClock("hola")).toBeNaN();
  });
});
