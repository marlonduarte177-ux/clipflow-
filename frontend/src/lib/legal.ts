import { PLANS } from "@clipflow/shared";

/** Datos del responsable del servicio, usados en las páginas legales. */
export const LEGAL = {
  owner: "Marlon Duarte",
  country: "Costa Rica",
  email: "soporte@clipflowia.com",
  site: "clipflowia.com",
  updated: "9 de octubre de 2026",
  /** Los mismos planes que cobra la app (shared/src/billing.ts). */
  plans: PLANS,
  refund: { days: 7, maxMinutesUsed: 15 },
} as const;
