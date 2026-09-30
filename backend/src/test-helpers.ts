import type { FastifyInstance } from "fastify";
import type { DbHandle } from "@clipflow/shared/db";
import { createTestDb } from "@clipflow/shared/db/testing";
import { DEFAULT_PRODUCT_CONFIG, type ProductConfig } from "@clipflow/shared";
import { buildApp } from "./app.js";
import type { TokenVerifier } from "./auth.js";
import type { VideoStorage } from "./storage.js";

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

/** S3 falso en memoria: registra las subidas y permite simular el tamaño final. */
export class FakeStorage implements VideoStorage {
  uploads = new Map<string, { key: string; contentType: string; aborted: boolean; completedParts?: number }>();
  objects = new Map<string, number>();
  /** Tamaño que tendrá el objeto final en S3 (el test lo fija para simular éxito o alteración). */
  forceSize: number | undefined;
  private counter = 0;

  async createMultipartUpload(key: string, contentType: string) {
    const id = `upload-${++this.counter}`;
    this.uploads.set(id, { key, contentType, aborted: false });
    return id;
  }
  async presignUploadPart(key: string, uploadId: string, partNumber: number, expires: number) {
    return `https://s3.test/${key}?uploadId=${uploadId}&partNumber=${partNumber}&expires=${expires}`;
  }
  async completeMultipartUpload(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]) {
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.key !== key || upload.aborted) throw new Error("NoSuchUpload");
    upload.completedParts = parts.length;
    this.objects.set(key, this.forceSize ?? 0);
  }
  async abortMultipartUpload(_key: string, uploadId: string) {
    const upload = this.uploads.get(uploadId);
    if (upload) upload.aborted = true;
  }
  async getObjectSize(key: string) {
    return this.objects.get(key) ?? null;
  }
  async deleteObject(key: string) {
    this.objects.delete(key);
  }
}

export interface TestContext {
  app: FastifyInstance;
  database: DbHandle;
  storage: FakeStorage;
}

export async function createTestApp(product: ProductConfig = DEFAULT_PRODUCT_CONFIG): Promise<TestContext> {
  const database = await createTestDb();
  const storage = new FakeStorage();
  const app = await buildApp({
    config: {
      APP_ENV: "development",
      LOG_LEVEL: "error",
      CORS_ALLOWED_ORIGINS: ["http://localhost:3000"],
      S3_UPLOAD_URL_EXPIRES_SECONDS: 900,
    },
    db: database.db,
    storage,
    product,
    verifyToken,
    lookupEmail: async (token) => `${token.split(".")[1]}@example.com`,
    logger: false,
  });
  return { app, database, storage };
}

export async function closeTestApp(ctx: TestContext | undefined) {
  await ctx?.app.close();
  await ctx?.database.close();
}
