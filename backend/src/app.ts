import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import type { MeResponse, ProductConfig } from "@clipflow/shared";
import { getCreditBalance, type Database } from "@clipflow/shared/db";
import { accountRoutes } from "./account.js";
import { BILLING_OFF, billingRoutes, type BillingSettings } from "./billing.js";
import type { ApiConfig } from "./config.js";
import { requireAuth, type EmailLookup, type TokenVerifier } from "./auth.js";
import { clipRoutes } from "./clips.js";
import { jobRoutes } from "./jobs.js";
import { projectRoutes } from "./projects.js";
import type { WorkerLauncher } from "./launcher.js";
import type { JobQueue } from "./queue.js";
import type { VideoStorage } from "./storage.js";
import { videoRoutes } from "./videos.js";

export interface AppDeps {
  config: Pick<ApiConfig, "APP_ENV" | "LOG_LEVEL" | "CORS_ALLOWED_ORIGINS" | "S3_UPLOAD_URL_EXPIRES_SECONDS">;
  verifyToken: TokenVerifier;
  lookupEmail: EmailLookup;
  db: Database;
  storage: VideoStorage;
  queue: JobQueue;
  launcher: WorkerLauncher;
  product: ProductConfig;
  /** Pagos con Paddle. Sin esto (tests, local) se procesa sin plan. */
  billing?: BillingSettings;
  /** false en tests para no llenar la salida de logs. */
  logger?: boolean;
}

export async function buildApp({ config, verifyToken, lookupEmail, db, storage, queue, launcher, product, billing = BILLING_OFF, logger = true }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger
      ? {
          level: config.LOG_LEVEL,
          // Nunca escribir tokens ni cookies en los logs.
          redact: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
        }
      : false,
    // Evita que peticiones enormes lleguen a la lógica (los videos van directo a S3).
    bodyLimit: 1024 * 1024,
  });

  // Peticiones sin cuerpo (p. ej. POST /videos/:id/abort): algunos navegadores o proxies
  // les ponen un Content-Type igualmente. Un cuerpo vacío se acepta con cualquier tipo;
  // un cuerpo con contenido solo se acepta como JSON.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = String(body);
    if (text.trim() === "") return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      done(Object.assign(new Error("El cuerpo no es JSON válido."), { statusCode: 400, code: "invalid_json" }), undefined);
    }
  });
  app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => {
    if (String(body).trim() === "") return done(null, undefined);
    done(Object.assign(new Error("Envía los datos como JSON."), { statusCode: 415, code: "unsupported_media_type" }), undefined);
  });

  await app.register(cors, {
    origin: config.CORS_ALLOWED_ORIGINS,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Authorization", "Content-Type"],
    maxAge: 600,
  });

  // Errores inesperados: se registran completos, pero al cliente solo se le da un mensaje genérico.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err: error }, "error no controlado");
      return reply.code(500).send({
        error: { code: "internal_error", message: "Ocurrió un error inesperado. Intenta de nuevo." },
      });
    }
    return reply.code(status).send({
      error: { code: error.code ?? "bad_request", message: error.message },
    });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: { code: "not_found", message: "Ruta no encontrada." } }),
  );

  // Público: lo usan AWS (health check) y el monitoreo.
  app.get("/health", async () => ({ status: "ok", env: config.APP_ENV }));

  const auth = requireAuth({ verifyToken, lookupEmail, db });

  // Protegido: devuelve el usuario de ClipFlow asociado al token.
  app.get("/me", { preHandler: auth }, async (request): Promise<MeResponse> => {
    const creditMinutes = await getCreditBalance(db, request.user!.id);
    return { userId: request.user!.id, email: request.user!.email, creditMinutes };
  });
  await app.register(accountRoutes({ db, auth, storage }));
  await app.register(billingRoutes({ db, auth, settings: billing }));

  await app.register(projectRoutes({ db, auth, storage }));
  await app.register(
    videoRoutes({ db, auth, storage, queue, launcher, product, billing, uploadUrlExpiresSeconds: config.S3_UPLOAD_URL_EXPIRES_SECONDS }),
  );
  await app.register(jobRoutes({ db, auth, queue, launcher, billing }));
  await app.register(clipRoutes({ db, auth, storage }));

  return app;
}
