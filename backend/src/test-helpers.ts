import type { FastifyInstance } from "fastify";
import type { DbHandle } from "@clipflow/shared/db";
import { createTestDb } from "@clipflow/shared/db/testing";
import { buildApp } from "./app.js";
import type { TokenVerifier } from "./auth.js";

/** Tokens falsos para tests: "token-<sub>" es válido para el usuario <sub>. */
export const tokenFor = (sub: string) => `aaa.${sub}.zzz`;
export const bearer = (sub: string) => ({ authorization: `Bearer ${tokenFor(sub)}` });

const verifyToken: TokenVerifier = async (token) => {
  const [, sub] = token.split(".");
  if (!sub || sub === "invalid") {
    throw Object.assign(new Error("invalid"), { name: "JwtInvalidSignatureError" });
  }
  return { cognitoSub: sub };
};

export interface TestContext {
  app: FastifyInstance;
  database: DbHandle;
}

export async function createTestApp(): Promise<TestContext> {
  const database = await createTestDb();
  const app = await buildApp({
    config: { APP_ENV: "development", LOG_LEVEL: "error", CORS_ALLOWED_ORIGINS: ["http://localhost:3000"] },
    db: database.db,
    verifyToken,
    lookupEmail: async (token) => `${token.split(".")[1]}@example.com`,
    logger: false,
  });
  return { app, database };
}

export async function closeTestApp(ctx: TestContext | undefined) {
  await ctx?.app.close();
  await ctx?.database.close();
}
