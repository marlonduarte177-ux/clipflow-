import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import type { TokenVerifier } from "./auth.js";
import { loadApiConfig } from "./config.js";

// Token con forma de JWT (tres partes). La verificación real se sustituye en tests.
const VALID = "aaa.bbb.ccc";
const verifyToken: TokenVerifier = async (token) => {
  if (token === VALID) return { userId: "user-123" };
  throw Object.assign(new Error("invalid"), { name: "JwtInvalidSignatureError" });
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function makeApp() {
  app = await buildApp({
    config: { APP_ENV: "development", LOG_LEVEL: "error", CORS_ALLOWED_ORIGINS: ["http://localhost:3000"] },
    verifyToken,
    logger: false,
  });
  return app;
}

describe("API", () => {
  it("GET /health responde sin autenticación", async () => {
    const res = await (await makeApp()).inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", env: "development" });
  });

  it("GET /me sin token devuelve 401", async () => {
    const res = await (await makeApp()).inject({ method: "GET", url: "/me" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("GET /me con cabecera mal formada devuelve 401", async () => {
    const res = await (await makeApp()).inject({
      method: "GET",
      url: "/me",
      headers: { authorization: "Basic abc" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("GET /me con token inválido devuelve 401", async () => {
    const res = await (await makeApp()).inject({
      method: "GET",
      url: "/me",
      headers: { authorization: "Bearer xxx.yyy.zzz" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toMatch(/expiró/);
  });

  it("GET /me con token válido devuelve el usuario del token", async () => {
    const res = await (await makeApp()).inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${VALID}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: "user-123" });
  });

  it("CORS solo permite los orígenes configurados", async () => {
    const a = await makeApp();
    const allowed = await a.inject({
      method: "OPTIONS",
      url: "/me",
      headers: { origin: "http://localhost:3000", "access-control-request-method": "GET" },
    });
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    const denied = await a.inject({
      method: "OPTIONS",
      url: "/me",
      headers: { origin: "https://malicioso.example", "access-control-request-method": "GET" },
    });
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rutas desconocidas devuelven 404 con formato de error", async () => {
    const res = await (await makeApp()).inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });
});

describe("loadApiConfig", () => {
  it("falla con un mensaje claro si falta Cognito", () => {
    expect(() => loadApiConfig({})).toThrow(/COGNITO_USER_POOL_ID/);
  });

  it("lee y separa los orígenes CORS", () => {
    const config = loadApiConfig({
      COGNITO_USER_POOL_ID: "us-east-1_AbC123",
      COGNITO_CLIENT_ID: "client",
      CORS_ALLOWED_ORIGINS: "http://a.test, https://b.test",
    });
    expect(config.CORS_ALLOWED_ORIGINS).toEqual(["http://a.test", "https://b.test"]);
    expect(config.API_PORT).toBe(4000);
  });
});
