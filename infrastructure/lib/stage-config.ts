import type { Stage } from "./stage.js";

/**
 * Valores por entorno que no son secretos. Cambiarlos aquí y desplegar.
 */
export interface StageConfig {
  /** Direcciones de la web que pueden llamar a la API y subir a S3 (CORS). */
  webOrigins: string[];
}

export const STAGE_CONFIG: Record<Stage, StageConfig> = {
  dev: {
    webOrigins: ["http://localhost:3000"],
  },
  staging: {
    webOrigins: [
      // Dominio propio (03/10/2026), con y sin "www".
      "https://clipflowia.com",
      "https://www.clipflowia.com",
      "https://main.dqw8wqexijjzj.amplifyapp.com",
      "http://localhost:3000",
    ],
  },
  production: {
    // Se completa cuando exista el dominio (Fase 10).
    webOrigins: [],
  },
};

export function stageConfig(stage: Stage): StageConfig {
  const config = STAGE_CONFIG[stage];
  if (config.webOrigins.length === 0) {
    throw new Error(`Configura webOrigins para "${stage}" en infrastructure/lib/stage-config.ts`);
  }
  return config;
}
