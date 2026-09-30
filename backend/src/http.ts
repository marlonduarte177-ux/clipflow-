import type { FastifyReply } from "fastify";
import type { z } from "zod";

/** Respuestas de error con el mismo formato en toda la API. */
export function sendError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message } });
}

export function sendValidationError(reply: FastifyReply, error: z.ZodError) {
  return sendError(reply, 400, "validation_error", error.issues[0]?.message ?? "Datos inválidos.");
}
