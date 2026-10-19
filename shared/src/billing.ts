/**
 * Planes de ClipFlow (ver docs/planes-y-creditos.md). 1 minuto de crédito = 1 minuto de video.
 * Los precios reales los cobra Polar; aquí solo se muestran.
 */
export const PLANS = {
  /** Prueba gratis de 7 días con 60 min (pide tarjeta). Al terminar pasa sola al Básico, si no se cancela. */
  trial: { code: "trial", minutes: 60, priceUsd: 0, days: 7 },
  basic: { code: "basic", minutes: 200, priceUsd: 9.99 },
  pro: { code: "pro", minutes: 400, priceUsd: 19.99 },
  max: { code: "max", minutes: 1000, priceUsd: 39.99 },
} as const;

export type PlanCode = keyof typeof PLANS;
/** Planes mensuales (los que se pueden contratar directamente). */
export const MONTHLY_PLANS = ["basic", "pro", "max"] as const;
export type MonthlyPlanCode = (typeof MONTHLY_PLANS)[number];

/** Estado de la suscripción tal como lo ve la web. */
export type BillingStatus = "trialing" | "active" | "past_due" | "canceled" | "expired";

/** Lo que la web necesita para mostrar el plan y abrir el pago (nada secreto). */
export interface BillingResponse {
  /** false mientras los pagos no estén activados: se puede procesar sin plan. */
  enabled: boolean;
  /** La cuenta no necesita plan (p. ej. la del dueño). */
  exempt: boolean;
  creditMinutes: number;
  subscription: {
    planCode: PlanCode;
    status: BillingStatus;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  } | null;
  /** Puede usar la prueba gratis de 7 días (nunca tuvo un plan): el Básico empieza con ella. */
  trialEligible: boolean;
  /** Los pagos con Polar están listos (POST /billing/checkout abre el pago). */
  checkoutReady: boolean;
  /** Tiene suscripción en Polar: POST /billing/portal abre «Gestionar suscripción». */
  portalAvailable: boolean;
}

/** Errores de la API cuando falta plan o minutos (la web muestra «Ver planes»). */
export const NO_PLAN_CODE = "no_plan";
export const NO_MINUTES_CODE = "no_minutes";
export const NO_PLAN_MESSAGE = "Necesitas un plan para crear clips. Elige uno en Planes.";
export const NO_MINUTES_MESSAGE = "Ya usaste todos los minutos de tu plan. Se recargan con la próxima renovación.";
/** El video (o el tramo) gasta más minutos de los que quedan: hay que elegir un tramo más corto. */
export const NOT_ENOUGH_MINUTES_CODE = "not_enough_minutes";
export function notEnoughMinutesMessage(need: number, left: number): string {
  return `Este video dura ${need} min y te quedan ${left} min. Elige un tramo más corto en «Duración del video» o mejora tu plan.`;
}

/** Minutos que gasta un video (se redondea hacia arriba; mínimo 1). */
export function minutesForSeconds(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / 60));
}

/** ¿Este correo está exento de pagar? (lista separada por comas, sin distinguir mayúsculas). */
export function isBillingExempt(email: string | null | undefined, freeEmails: string | undefined): boolean {
  if (!email || !freeEmails) return false;
  const list = freeEmails
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email.trim().toLowerCase());
}
