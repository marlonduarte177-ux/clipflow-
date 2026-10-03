import type { FastifyPluginAsync, preHandlerHookHandler } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { schema, type Database } from "@clipflow/shared/db";
import { deleteVideoRows, purgeVideoFiles } from "./cleanup.js";
import type { VideoStorage } from "./storage.js";

const { projects, users } = schema;

/**
 * Eliminar la cuenta (DELETE /me): borra todos los proyectos, videos, clips y archivos del
 * usuario, y desactiva su fila. La web elimina después el usuario de Cognito.
 * - El historial de créditos y consumo se conserva (es contable y no se puede borrar), pero
 *   queda separado de la persona: sin correo y sin el identificador de Cognito.
 * - Si un video se está procesando en este momento, responde 409 y no borra nada más.
 */
export function accountRoutes(deps: { db: Database; auth: preHandlerHookHandler; storage: VideoStorage }): FastifyPluginAsync {
  return async (app) => {
    app.delete("/me", { preHandler: deps.auth }, async (request, reply) => {
      const userId = request.user!.id;
      const own = await deps.db.select({ id: projects.id }).from(projects).where(eq(projects.userId, userId));
      for (const project of own) {
        const removed = await deleteVideoRows(deps.db, userId, { projectId: project.id });
        if (removed.status === "busy") {
          return reply.code(409).send({
            error: {
              code: "video_processing",
              message: "Hay un video procesándose. Espera a que termine (o cancélalo) y vuelve a intentarlo.",
            },
          });
        }
        if (removed.status === "deleted") await purgeVideoFiles(deps.storage, removed.files, request.log);
      }
      // Por si quedó algo suelto (p. ej. transcripciones guardadas).
      await purgeVideoFiles(deps.storage, { prefixes: [`transcripts/${userId}/`], keys: [], uploads: [] }, request.log);
      await deps.db
        .update(users)
        .set({ deletedAt: new Date(), email: null, cognitoSub: `deleted:${userId}` })
        .where(and(eq(users.id, userId), isNull(users.deletedAt)));
      request.log.info({ userId }, "cuenta eliminada");
      return reply.code(204).send();
    });
  };
}
