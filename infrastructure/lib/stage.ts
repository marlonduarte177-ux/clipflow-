/** Entornos de ClipFlow. Todos se crean con el mismo código. */
export const STAGES = ["dev", "staging", "production"] as const;
export type Stage = (typeof STAGES)[number];

export function parseStage(value: unknown): Stage {
  if (typeof value === "string" && (STAGES as readonly string[]).includes(value)) {
    return value as Stage;
  }
  throw new Error(
    `Indica el entorno con -c stage=<${STAGES.join("|")}> (recibido: ${JSON.stringify(value)})`,
  );
}

/** Nombre base de los recursos, p. ej. "clipflow-staging". */
export const resourcePrefix = (stage: Stage) => `clipflow-${stage}`;
