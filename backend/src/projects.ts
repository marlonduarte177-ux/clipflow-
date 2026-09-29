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

const notFound = { error: { code: "not_found", message: "Proyecto no encontrado." } };

function validationError(error: z.ZodError) {
  return { error: { code: "validation_error", message: error.issues[0]?.message ?? "Datos inválidos." } };
}

/**
 * Rutas de proyectos. REGLA: toda consulta filtra por `request.user.id`.
 * Un proyecto de otro usuario responde 404 (no se revela que existe).
 */
export function projectRoutes(deps: { db: Database; auth: preHandlerHookHandler }) {
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
      if (!input.success) return reply.code(400).send(validationError(input.error));
      const [row] = await db
        .insert(projects)
        .values({ userId: request.user!.id, name: input.data.name, description: input.data.description ?? null })
        .returning();
      return reply.code(201).send(toDto(row!));
    });

    app.get("/projects/:id", async (request, reply) => {
      const params = IdParams.safeParse(request.params);
      if (!params.success) return reply.code(404).send(notFound);
      const [row] = await db
        .select()
        .from(projects)
        .where(and(eq(projects.id, params.data.id), eq(projects.userId, request.user!.id)));
      return row ? toDto(row) : reply.code(404).send(notFound);
    });

    app.patch("/projects/:id", async (request, reply) => {
      const params = IdParams.safeParse(request.params);
      if (!params.success) return reply.code(404).send(notFound);
      const input = ProjectUpdateSchema.safeParse(request.body);
      if (!input.success) return reply.code(400).send(validationError(input.error));
      const [row] = await db
        .update(projects)
        .set({
          ...(input.data.name !== undefined ? { name: input.data.name } : {}),
          ...(input.data.description !== undefined ? { description: input.data.description ?? null } : {}),
        })
        .where(and(eq(projects.id, params.data.id), eq(projects.userId, request.user!.id)))
        .returning();
      return row ? toDto(row) : reply.code(404).send(notFound);
    });

    app.delete("/projects/:id", async (request, reply) => {
      const params = IdParams.safeParse(request.params);
      if (!params.success) return reply.code(404).send(notFound);
      const deleted = await db
        .delete(projects)
        .where(and(eq(projects.id, params.data.id), eq(projects.userId, request.user!.id)))
        .returning({ id: projects.id });
      return deleted.length > 0 ? reply.code(204).send() : reply.code(404).send(notFound);
    });
  };
}
