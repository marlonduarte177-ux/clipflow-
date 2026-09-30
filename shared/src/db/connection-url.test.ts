import { describe, expect, it } from "vitest";
import { databaseUrlFromEnv } from "./connection-url.js";

describe("databaseUrlFromEnv", () => {
  it("usa DATABASE_URL si existe", () => {
    expect(databaseUrlFromEnv({ DATABASE_URL: "postgres://a:b@h/db" })).toBe("postgres://a:b@h/db");
  });

  it("arma la URL desde las variables de AWS y escapa la contraseña", () => {
    const url = databaseUrlFromEnv({
      DB_HOST: "db.example.internal",
      DB_NAME: "clipflow",
      DB_USER: "clipflow_admin",
      DB_PASSWORD: "p@ss:w/rd#?",
    });
    const parsed = new URL(url);
    expect(parsed.hostname).toBe("db.example.internal");
    expect(parsed.port).toBe("5432");
    expect(parsed.pathname).toBe("/clipflow");
    expect(decodeURIComponent(parsed.password)).toBe("p@ss:w/rd#?");
  });

  it("falla con un mensaje claro si falta algo", () => {
    expect(() => databaseUrlFromEnv({ DB_HOST: "x" })).toThrow(/DB_PASSWORD/);
  });
});
