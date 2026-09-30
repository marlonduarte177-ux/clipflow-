import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  ProjectInputSchema,
  ProjectUpdateSchema,
  type ProjectDto,
  type ProjectListResponse,
} from "@clipflow/shared";
import { schema, type Database } from "@clipflow/shared/db";
import { deleteVideoRows, purgeVideoFiles } from "./cleanup.js";
import { sendError, sendValidationError } from "./http.js";
import type { VideoStorage } from "./storage.js";

const { projects } = schema;
type ProjectRow = typeof projects.$inferSelect;

const IdParams = z.object({ id: z.uuid() });

function toDto(row: ProjectRow): ProjectDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}


/**
 * Rutas de proyectos. REGLA: toda consulta filtra por `request.user.id`.
 * Un proyecto de otro usuario responde 404 (no se revela que existe).
 */
export function projectRoutes(deps: { db: Database; auth: preHandlerHookHandler; storage: VideoStorage }) {
  const { db } = deps;
  return async (app: FastifyInstance) => {
    app.addHook("preHandler", deps.auth);

    app.get("/projects", async (request): Promise<ProjectListResponse> => {
      const rows = await db
        .select()
        .from(projects)
        .where(eq(projects.userId, request.user!.id))
        .orderBy(desc(projects.createdAt))
        .limit(200);
      return { projects: rows.map(toDto) };
    });

    app.post("/projects", async (request, reply) => {
      const input = ProjectInputSchema.safeParse(request.body);
      if (!input.success) return sendValidationError(reply, input.error);
      const [row] = await db
        .insert(projects)
        .values({ userId: request.user!.id, name: input.data.name, description: input.data.description ?? null })
        .returning();
      return reply.code(201).send(toDto(row!));
    });

    app.get("/projects/:id", async (request, reply) => {
      const params = IdParams.safeParse(request.params);
      if (!params.success) return sendError(reply, 404, "not_found", "Proyecto no encontrado.");
      const [row] = await db
        .select()
        .from(projects)
        .where(and(eq(projects.id, params.data.id), eq(projects.userId, request.user!.id)));
      return row ? toDto(row) : sendError(reply, 404, "not_found", "Proyecto no encontrado.");
    });

    app.patch("/projects/:id", async (request, reply) => {
      const params = IdParams.safeParse(request.params);
      if (!params.success) return sendError(reply, 404, "not_found", "Proyecto no encontrado.");
      const input = ProjectUpdateSchema.safeParse(request.body);
      if (!input.success) return sendValidationError(reply, input.error);
      const [row] = await db
        .update(projects)
        .set({
          ...(input.data.name !== undefined ? { name: input.data.name } : {}),
          ...(input.data.description !== undefined ? { description: input.data.description ?? null } : {}),
        })
        .where(and(eq(projects.id, params.data.id), eq(projects.userId, request.user!.id)))
        .returning();
      return row ? toDto(row) : sendError(reply, 404, "not_found", "Proyecto no encontrado.");
    });

    // Borra el proyecto con sus videos, clips y archivos en S3.
    app.delete("/projects/:id", async (request, reply) => {
      const params = IdParams.safeParse(request.params);
      if (!params.success) return sendError(reply, 404, "not_found", "Proyecto no encontrado.");
      const userId = request.user!.id;
      const removed = await deleteVideoRows(db, userId, { projectId: params.data.id });
      if (removed.status === "not_found") return sendError(reply, 404, "not_found", "Proyecto no encontrado.");
      if (removed.status === "busy") {
        return sendError(reply, 409, "video_processing", "Un video de este proyecto se está procesando. Cancélalo o espera a que termine.");
      }
      await purgeVideoFiles(deps.storage, removed.files, request.log);
      request.log.info({ projectId: params.data.id, videos: removed.videoIds.length }, "proyecto eliminado");
      return reply.code(204).send();
    });
  };
}
