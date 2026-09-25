import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import type { MeResponse } from "@clipflow/shared";
import type { Database } from "@clipflow/shared/db";
import type { ApiConfig } from "./config.js";
import { requireAuth, type EmailLookup, type TokenVerifier } from "./auth.js";
import { projectRoutes } from "./projects.js";

export interface AppDeps {
  config: Pick<ApiConfig, "APP_ENV" | "LOG_LEVEL" | "CORS_ALLOWED_ORIGINS">;
  verifyToken: TokenVerifier;
  lookupEmail: EmailLookup;
  db: Database;
  /** false en tests para no llenar la salida de logs. */
  logger?: boolean;
}

export async function buildApp({ config, verifyToken, lookupEmail, db, logger = true }: AppDeps): Promise<FastifyInstance> {
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
    return { userId: request.user!.id, email: request.user!.email };
  });

  await app.register(projectRoutes({ db, auth }));

  return app;
}
