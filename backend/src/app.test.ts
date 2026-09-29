import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadApiConfig } from "./config.js";
import { bearer, closeTestApp, createTestApp, type TestContext } from "./test-helpers.js";

let ctx: TestContext | undefined;
beforeEach(async () => {
  ctx = await createTestApp();
});
afterEach(async () => {
  await closeTestApp(ctx);
  ctx = undefined;
});
const app = () => ctx!.app;

describe("API", () => {
  it("GET /health responde sin autenticación", async () => {
    const res = await app().inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", env: "development" });
  });

  it("GET /me sin token devuelve 401", async () => {
    const res = await app().inject({ method: "GET", url: "/me" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("GET /me con cabecera mal formada devuelve 401", async () => {
    const res = await app().inject({ method: "GET", url: "/me", headers: { authorization: "Basic abc" } });
    expect(res.statusCode).toBe(401);
  });

  it("GET /me con token inválido devuelve 401", async () => {
    const res = await app().inject({ method: "GET", url: "/me", headers: bearer("invalid") });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toMatch(/expiró/);
  });

  it("GET /me crea el usuario la primera vez y luego lo reutiliza", async () => {
    const first = await app().inject({ method: "GET", url: "/me", headers: bearer("sub-1") });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ email: "sub-1@example.com" });
    const second = await app().inject({ method: "GET", url: "/me", headers: bearer("sub-1") });
    expect(second.json().userId).toBe(first.json().userId);
  });

  it("CORS solo permite los orígenes configurados", async () => {
    const allowed = await app().inject({
      method: "OPTIONS",
      url: "/me",
      headers: { origin: "http://localhost:3000", "access-control-request-method": "GET" },
    });
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    const denied = await app().inject({
      method: "OPTIONS",
      url: "/me",
      headers: { origin: "https://malicioso.example", "access-control-request-method": "GET" },
    });
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rutas desconocidas devuelven 404 con formato de error", async () => {
    const res = await app().inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });
});

describe("loadApiConfig", () => {
  it("falla con un mensaje claro si falta Cognito o la base de datos", () => {
    expect(() => loadApiConfig({})).toThrow(/COGNITO_USER_POOL_ID/);
    expect(() => loadApiConfig({})).toThrow(/DATABASE_URL/);
  });

  it("lee y separa los orígenes CORS", () => {
    const config = loadApiConfig({
      DATABASE_URL: "postgres://u:p@localhost:5432/db",
      COGNITO_USER_POOL_ID: "us-east-1_AbC123",
      COGNITO_CLIENT_ID: "client",
      CORS_ALLOWED_ORIGINS: "http://a.test, https://b.test",
    });
    expect(config.CORS_ALLOWED_ORIGINS).toEqual(["http://a.test", "https://b.test"]);
    expect(config.API_PORT).toBe(4000);
    expect(config.DATABASE_SSL).toBe(false);
  });
});
