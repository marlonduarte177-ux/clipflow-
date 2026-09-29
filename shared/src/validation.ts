import { z } from "zod";

/** Validaciones compartidas: el frontend las usa para avisar antes, la API para rechazar. */
export const ProjectInputSchema = z.object({
  name: z.string().trim().min(1, "El nombre es obligatorio").max(120, "Máximo 120 caracteres"),
  description: z.string().trim().max(1000, "Máximo 1000 caracteres").nullish(),
});

export const ProjectUpdateSchema = ProjectInputSchema.partial().refine(
  (value) => value.name !== undefined || value.description !== undefined,
  { message: "No hay cambios" },
);

export type ProjectInput = z.infer<typeof ProjectInputSchema>;
export type ProjectUpdate = z.infer<typeof ProjectUpdateSchema>;
