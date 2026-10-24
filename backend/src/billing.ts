import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, preHandlerHookHandler } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  FEATURES,
  isBillingExempt,
  NO_MINUTES_CODE,
  NO_MINUTES_MESSAGE,
  NO_PLAN_CODE,
  NO_PLAN_MESSAGE,
  NOT_ENOUGH_MINUTES_CODE,
  notEnoughMinutesMessage,
  minutesForSeconds,
  MONTHLY_PLANS,
  PLANS,
  type BillingResponse,
  type BillingStatus,
  type MonthlyPlanCode,
  type PlanCode,
} from "@clipflow/shared";
import {
  getCreditBalance,
  effectiveStatus,
  latestSubscription,
  schema,
  setPlanMinutes,
  subscriptionAllowsProcessing,
  type Database,
} from "@clipflow/shared/db";
import type { AuthUser } from "./auth.js";
import type { ApiConfig } from "./config.js";
import { sendError } from "./http.js";
import type { LiveSecret } from "./secrets.js";

const { subscriptions, users } = schema;

export type BillingSettings = Pick<
  ApiConfig,
  | "BILLING_ENABLED"
  | "BILLING_FREE_EMAILS"
  | "POLAR_SERVER"
  | "POLAR_PRODUCT_BASIC"
  | "POLAR_PRODUCT_PRO"
  | "POLAR_PRODUCT_MAX"
  | "POLAR_ACCESS_TOKEN"
  | "POLAR_WEBHOOK_SECRET"
>;

/** Sin pagos (local y tests): se procesa sin plan. */
export const BILLING_OFF: BillingSettings = { BILLING_ENABLED: false, POLAR_SERVER: "sandbox" };

const PROVIDER = "polar";
const POLAR_API = { sandbox: "https://sandbox-api.polar.sh", production: "https://api.polar.sh" } as const;

/**
 * Valor pegado en Secrets Manager, limpio: acepta la pestaña «Key/value» de AWS (JSON con un solo
 * valor), comillas y espacios alrededor. undefined si está vacío.
 */
function storedValue(stored: string | undefined): string | undefined {
  let v = (stored ?? "").trim();
  if (v.startsWith("{")) {
    try {
      const values = Object.values(JSON.parse(v) as Record<string, unknown>).filter((x): x is string => typeof x === "string");
      v = values.length === 1 ? values[0]!.trim() : v;
    } catch {
      // No es JSON: se usa tal cual.
    }
  }
  v = v.replace(/^["']+|["']+$/g, "").trim();
  return v || undefined;
}

/** El token de Polar (polar_oat_…) tal como se pegó. null si falta (p. ej. sigue el relleno de AWS). */
export function polarAccessToken(stored: string | undefined): string | null {
  const found = /polar_oat_[A-Za-z0-9_-]{10,}/.exec(storedValue(stored) ?? "");
  return found ? found[0] : null;
}

/** La clave de los avisos de Polar. null si falta. */
export function polarWebhookSecret(stored: string | undefined): string | null {
  return storedValue(stored) ?? null;
}

/** Forma de lo guardado como clave, sin revelarla: sirve para saber qué se pegó mal. */
export function describeStoredSecret(stored: string | undefined): Record<string, unknown> {
  const v = stored ?? "";
  return {
    largo: v.length,
    vacio: v.trim() === "",
    json: v.trim().startsWith("{"),
    espaciosOSaltos: /\s/.test(v.trim()),
    comillas: /["']/.test(v),
    empiezaConPolar: /^polar_/i.test(v.trim()),
    empiezaConWhsec: /^whsec_/i.test(v.trim()),
  };
}

/**
 * ¿Puede crear clips? null = sí. Si no, el error para la API (402). Solo se exige con los pagos
 * activados y para cuentas no exentas. Los minutos exactos los descuenta el procesador al medir el video.
 */
export async function billingBlock(
  db: Database,
  settings: BillingSettings,
  user: Pick<AuthUser, "id" | "email">,
): Promise<{ code: string; message: string } | null> {
  if (!settings.BILLING_ENABLED || isBillingExempt(user.email, settings.BILLING_FREE_EMAILS)) return null;
  if (!subscriptionAllowsProcessing(await latestSubscription(db, user.id))) return { code: NO_PLAN_CODE, message: NO_PLAN_MESSAGE };
  if ((await getCreditBalance(db, user.id)) <= 0) return { code: NO_MINUTES_CODE, message: NO_MINUTES_MESSAGE };
  return null;
}

/** Responde 402 si no puede crear clips. Devuelve true si respondió (la ruta debe terminar). */
export async function replyIfBlocked(
  db: Database,
  settings: BillingSettings,
  user: Pick<AuthUser, "id" | "email">,
  reply: FastifyReply,
): Promise<boolean> {
  const block = await billingBlock(db, settings, user);
  if (!block) return false;
  await sendError(reply, 402, block.code, block.message);
  return true;
}

/** «Guardar» (bajar un video de otra plataforma tal cual): solo para los correos de administrador. */
export function canSaveVideos(settings: BillingSettings, user: Pick<AuthUser, "email">): boolean {
  return FEATURES.downloadOnly && isBillingExempt(user.email, settings.BILLING_FREE_EMAILS);
}

/** Importar de YouTube (con Apify, ~0,13 USD por video): solo los administradores. */
export function canImportYoutube(settings: BillingSettings, user: Pick<AuthUser, "email">): boolean {
  return isBillingExempt(user.email, settings.BILLING_FREE_EMAILS);
}

/**
 * ¿Le alcanzan los minutos para este video (o el tramo elegido)? Si no, responde 402 antes de empezar:
 * así no se descarga ni se procesa nada que después no se podría cobrar. `seconds` null = duración
 * todavía desconocida (el procesador la mide y vuelve a revisar). Devuelve true si respondió.
 */
export async function replyIfNotEnoughMinutes(
  db: Database,
  settings: BillingSettings,
  user: Pick<AuthUser, "id" | "email">,
  seconds: number | null | undefined,
  reply: FastifyReply,
): Promise<boolean> {
  if (!seconds || !settings.BILLING_ENABLED || isBillingExempt(user.email, settings.BILLING_FREE_EMAILS)) return false;
  const need = minutesForSeconds(seconds);
  const left = await getCreditBalance(db, user.id);
  if (need <= left) return false;
  await sendError(reply, 402, NOT_ENOUGH_MINUTES_CODE, notEnoughMinutesMessage(need, left));
  return true;
}

/** Segundos que se van a procesar: el tramo elegido o el video completo. */
export function secondsToProcess(params: { rangeStartSeconds?: number; rangeEndSeconds?: number }, videoSeconds: number | null | undefined) {
  if (params.rangeStartSeconds !== undefined && params.rangeEndSeconds !== undefined) {
    const end = videoSeconds ? Math.min(params.rangeEndSeconds, videoSeconds) : params.rangeEndSeconds;
    return Math.max(0, end - params.rangeStartSeconds);
  }
  return videoSeconds ?? null;
}

/**
 * Firma de los avisos de Polar (Standard Webhooks): HMAC-SHA256 de "id.timestamp.cuerpo", en base64,
 * en la cabecera webhook-signature ("v1,<firma>", varias separadas por espacios). La clave es el texto
 * de la clave tal cual; si empieza por "whsec_", también se prueba su forma en base64.
 */
export function verifyPolarSignature(
  rawBody: string,
  headers: { id?: string; timestamp?: string; signature?: string },
  secret: string,
  nowMs = Date.now(),
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  // Más de 5 minutos de diferencia: podría ser un aviso viejo reenviado por un tercero.
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > 300) return false;
  const keys = [Buffer.from(secret, "utf8")];
  if (secret.startsWith("whsec_")) keys.push(Buffer.from(secret.slice("whsec_".length), "base64"));
  const given = signature
    .split(" ")
    .map((part) => part.split(","))
    .filter(([version, value]) => version === "v1" && value)
    .map(([, value]) => Buffer.from(value!, "base64"));
  return keys.some((key) => {
    const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest();
    return given.some((sig) => sig.length === expected.length && timingSafeEqual(sig, expected));
  });
}

const Metadata = z.record(z.string(), z.unknown()).nullish();
const Customer = z.object({ id: z.string().nullish(), external_id: z.string().nullish() }).passthrough().nullish();
const PolarEvent = z.object({
  type: z.string(),
  timestamp: z.string().nullish(),
  data: z.record(z.string(), z.unknown()),
});
const PolarSubscription = z.object({
  id: z.string(),
  status: z.string(),
  product_id: z.string().nullish(),
  customer_id: z.string().nullish(),
  customer: Customer,
  metadata: Metadata,
  current_period_start: z.string().nullish(),
  current_period_end: z.string().nullish(),
  cancel_at_period_end: z.boolean().nullish(),
  ended_at: z.string().nullish(),
});
const PolarOrder = z.object({
  id: z.string(),
  paid: z.boolean().nullish(),
  status: z.string().nullish(),
  total_amount: z.number().nullish(),
  billing_reason: z.string().nullish(),
  product_id: z.string().nullish(),
  subscription_id: z.string().nullish(),
  customer: Customer,
  metadata: Metadata,
});

/** Estados de Polar → los de ClipFlow. */
const STATUS: Record<string, BillingStatus> = {
  trialing: "trialing",
  active: "active",
  past_due: "past_due",
  canceled: "canceled",
  unpaid: "expired",
  paused: "expired",
  incomplete: "expired",
  incomplete_expired: "expired",
};

/** Cargos de una suscripción que traen minutos: el primero, la renovación (y el fin de la prueba) y el cambio de plan. */
const PLAN_ORDERS = new Set(["subscription_create", "subscription_cycle", "subscription_update"]);

const userIdIn = (metadata: z.infer<typeof Metadata>) => (typeof metadata?.userId === "string" ? metadata.userId : undefined);

/** Dueño del pago: el que abrió el pago (external_id o metadata) o el de la suscripción ya guardada. */
async function resolveUser(db: Database, candidates: (string | null | undefined)[], subscriptionId: string | null | undefined) {
  for (const id of candidates) {
    if (!id || !z.uuid().safeParse(id).success) continue;
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, id));
    if (user) return user.id;
  }
  if (subscriptionId) {
    const [row] = await db
      .select({ userId: subscriptions.userId })
      .from(subscriptions)
      .where(and(eq(subscriptions.provider, PROVIDER), eq(subscriptions.providerSubscriptionId, subscriptionId)));
    if (row) return row.userId;
  }
  return null;
}

export class RetryLater extends Error {}

/** Plan mensual de cada producto de Polar. */
function planOfProduct(settings: BillingSettings, productId: string | null | undefined): MonthlyPlanCode | null {
  if (!productId) return null;
  if (productId === settings.POLAR_PRODUCT_BASIC) return "basic";
  if (productId === settings.POLAR_PRODUCT_PRO) return "pro";
  if (productId === settings.POLAR_PRODUCT_MAX) return "max";
  return null;
}

/**
 * Aplica un aviso de Polar. Idempotente: los avisos repetidos no cargan minutos dos veces y los
 * avisos viejos que llegan tarde no pisan el estado nuevo.
 * - Prueba (7 días, con tarjeta): 60 min. Al terminar, Polar cobra el Básico (aviso order.paid) → 200 min.
 * - Cada pago de un plan (primero, renovación, cambio) → los minutos de ese plan.
 * - Terminó (canceló y venció, o no pagó) → 0 min.
 */
export async function applyPolarEvent(db: Database, settings: BillingSettings, raw: unknown, log: FastifyBaseLogger): Promise<void> {
  const event = PolarEvent.parse(raw);
  const occurredAt = event.timestamp ? new Date(event.timestamp) : new Date();

  if (event.type.startsWith("subscription.")) {
    const sub = PolarSubscription.parse(event.data);
    const plan = planOfProduct(settings, sub.product_id);
    if (!plan) {
      log.warn({ event: event.type }, "aviso de Polar con un producto que no es de ClipFlow: se ignora");
      return;
    }
    const userId = await resolveUser(db, [sub.customer?.external_id, userIdIn(sub.metadata)], sub.id);
    if (!userId) throw new RetryLater("suscripción sin usuario");
    // Canceló durante la prueba: la prueba termina ya (sin minutos). Si no, alguien podría empezarla,
    // cancelarla en seguida y usar los 60 min gratis sin llegar nunca a pagar.
    const trialCanceled = sub.status === "trialing" && Boolean(sub.cancel_at_period_end);
    const status = trialCanceled ? "canceled" : (STATUS[sub.status] ?? "expired");
    const values = {
      userId,
      planCode: (sub.status === "trialing" ? "trial" : plan) as PlanCode,
      status,
      provider: PROVIDER,
      providerSubscriptionId: sub.id,
      providerCustomerId: sub.customer_id ?? sub.customer?.id ?? null,
      priceId: sub.product_id ?? null,
      providerEventAt: occurredAt,
      currentPeriodStart: sub.current_period_start ? new Date(sub.current_period_start) : null,
      currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end) : null,
      cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
    };
    const [existing] = await db
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.provider, PROVIDER), eq(subscriptions.providerSubscriptionId, sub.id)));
    if (existing?.providerEventAt && existing.providerEventAt > occurredAt) return; // aviso viejo
    // Polar manda varios avisos casi a la vez (created, active, updated…): se inserta o actualiza sin chocar.
    await db
      .insert(subscriptions)
      .values(values)
      .onConflictDoUpdate({
        target: [subscriptions.provider, subscriptions.providerSubscriptionId],
        targetWhere: sql`${subscriptions.provider} is not null`,
        set: values,
        setWhere: sql`${subscriptions.providerEventAt} is null or ${subscriptions.providerEventAt} <= ${occurredAt}`,
      });
    // Los minutos solo los cambia la suscripción más reciente (si ya contrató otra, la vieja no se los quita).
    const latest = await latestSubscription(db, userId);
    const isLatest = !latest || (latest.provider === PROVIDER && latest.providerSubscriptionId === sub.id);
    if (isLatest && status === "trialing") {
      // La prueba no tiene cobro: sus minutos se cargan con la suscripción (una sola vez; si la cancela y
      // la reactiva, no vuelven: los del Básico llegan con el primer cobro).
      await setPlanMinutes(db, { userId, minutes: PLANS.trial.minutes, eventId: `polar:${sub.id}:trial`, note: "prueba de 7 días" });
    } else if (isLatest && (status === "canceled" || status === "expired")) {
      await setPlanMinutes(db, {
        userId,
        minutes: 0,
        eventId: `polar:${sub.id}:${trialCanceled ? "trial-canceled" : status}`,
        note: trialCanceled ? "prueba cancelada" : "plan terminado",
      });
    }
    log.info({ event: event.type, status }, "suscripción actualizada");
    return;
  }

  if (event.type === "order.paid") {
    const order = PolarOrder.parse(event.data);
    // Solo los cargos de una suscripción con dinero (el primer cargo de la prueba es de 0 USD).
    if (!order.subscription_id || !PLAN_ORDERS.has(order.billing_reason ?? "") || !((order.total_amount ?? 0) > 0)) return;
    const plan = planOfProduct(settings, order.product_id);
    if (!plan) {
      log.warn({ event: event.type }, "pago con un producto que no es de ClipFlow: se ignora");
      return;
    }
    const userId = await resolveUser(db, [order.customer?.external_id, userIdIn(order.metadata)], order.subscription_id);
    if (!userId) throw new RetryLater("pago sin usuario");
    const applied = await setPlanMinutes(db, { userId, minutes: PLANS[plan].minutes, eventId: `polar:${order.id}`, note: `plan ${plan}` });
    log.info({ event: event.type, plan, applied }, "minutos del plan cargados");
  }
}

export interface BillingRouteDeps {
  db: Database;
  auth: preHandlerHookHandler;
  settings: BillingSettings;
  /** Direcciones de la web (para volver después de pagar). */
  webOrigins: string[];
  /** Para los tests: llamadas a Polar. */
  fetch?: typeof fetch;
  /**
   * El token y la clave de los avisos leídos de Secrets Manager mientras la API funciona: una clave
   * nueva se usa en menos de un minuto, sin desplegar. Sin esto (local, tests), los del arranque.
   */
  liveSecrets?: { accessToken?: LiveSecret; webhookSecret?: LiveSecret };
}

const CheckoutBody = z.object({ plan: z.enum(MONTHLY_PLANS) });

export function billingRoutes({ db, auth, settings, webOrigins, fetch: polarFetch = fetch, liveSecrets = {} }: BillingRouteDeps) {
  const products: Record<MonthlyPlanCode, string | undefined> = {
    basic: settings.POLAR_PRODUCT_BASIC,
    pro: settings.POLAR_PRODUCT_PRO,
    max: settings.POLAR_PRODUCT_MAX,
  };
  const productsReady = MONTHLY_PLANS.every((plan) => products[plan]);
  /** El token actual: el de Secrets Manager (si se puede leer) o el del arranque. */
  const currentToken = async (fresh = false) =>
    polarAccessToken((await liveSecrets.accessToken?.get(fresh)) ?? settings.POLAR_ACCESS_TOKEN);
  const currentWebhookSecret = async (fresh = false) =>
    (await liveSecrets.webhookSecret?.get(fresh)) ?? settings.POLAR_WEBHOOK_SECRET;
  const api = POLAR_API[settings.POLAR_SERVER];

  /** Dirección de la web que hizo la petición (si es una de las nuestras) para volver a ella. */
  const webOrigin = (origin: string | string[] | undefined) => {
    const given = Array.isArray(origin) ? origin[0] : origin;
    return given && webOrigins.includes(given) ? given : (webOrigins[0] ?? "http://localhost:3000");
  };

  /** Llama a Polar. Nunca registra el token ni datos del cliente: solo el código y el tipo de error. */
  async function polar<T>(path: string, body: unknown, log: FastifyBaseLogger): Promise<T | null> {
    try {
      const send = (token: string | null) =>
        polarFetch(`${api}${path}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
      const token = await currentToken();
      let res = await send(token);
      // Token rechazado: quizá se acaba de cambiar en Secrets Manager. Se relee y se prueba una vez más.
      if (res.status === 401 || res.status === 403) {
        const fresh = await currentToken(true);
        if (fresh && fresh !== token) res = await send(fresh);
      }
      const data = (await res.json().catch(() => null)) as (T & { error?: unknown; type?: unknown }) | null;
      if (!res.ok) {
        log.warn({ path, status: res.status, tipo: data?.error ?? data?.type ?? null }, "Polar rechazó la petición");
        return null;
      }
      return data;
    } catch (err) {
      log.warn({ path, reason: err instanceof Error ? err.name : "desconocido" }, "no se pudo hablar con Polar");
      return null;
    }
  }

  return async (app: FastifyInstance) => {
    app.get("/billing", { preHandler: auth }, async (request): Promise<BillingResponse> => {
      const user = request.user!;
      const sub = await latestSubscription(db, user.id);
      const token = await currentToken();
      return {
        enabled: settings.BILLING_ENABLED,
        exempt: isBillingExempt(user.email, settings.BILLING_FREE_EMAILS),
        creditMinutes: await getCreditBalance(db, user.id),
        subscription: sub
          ? {
              planCode: (sub.planCode in PLANS ? sub.planCode : "basic") as PlanCode,
              status: effectiveStatus(sub),
              currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
              cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
            }
          : null,
        trialEligible: !sub,
        checkoutReady: Boolean(token && productsReady),
        portalAvailable: Boolean(token && sub?.provider === PROVIDER),
      };
    });

    // Abre el pago de Polar para un plan. Básico, si nunca tuvo plan, empieza con 7 días gratis.
    app.post("/billing/checkout", { preHandler: auth }, async (request, reply) => {
      const user = request.user!;
      const parsed = CheckoutBody.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_plan", "Plan inválido.");
      if (!productsReady || !(await currentToken())) return sendError(reply, 503, "billing_not_configured", "Los pagos todavía no están disponibles.");
      const sub = await latestSubscription(db, user.id);
      // Ya tiene un plan: se cambia desde «Gestionar suscripción» (así no paga dos planes a la vez).
      if (sub?.provider === PROVIDER && subscriptionAllowsProcessing(sub)) {
        return sendError(reply, 409, "already_subscribed", "Ya tienes un plan. Cámbialo en Gestionar suscripción.");
      }
      const { plan } = parsed.data;
      const withTrial = plan === "basic" && !sub;
      const checkout = await polar<{ url?: string }>(
        "/v1/checkouts/",
        {
          products: [products[plan]],
          external_customer_id: user.id,
          ...(user.email ? { customer_email: user.email } : {}),
          metadata: { userId: user.id, plan },
          success_url: `${webOrigin(request.headers.origin)}/dashboard/planes?pago=ok`,
          allow_trial: withTrial,
          ...(withTrial ? { trial_interval: "day", trial_interval_count: PLANS.trial.days } : {}),
        },
        request.log,
      );
      if (!checkout?.url) return sendError(reply, 502, "checkout_failed", "No se pudo abrir el pago. Intenta de nuevo.");
      return { url: checkout.url };
    });

    // Portal de clientes de Polar: cambiar de plan o de tarjeta, ver facturas, cancelar.
    app.post("/billing/portal", { preHandler: auth }, async (request, reply) => {
      const user = request.user!;
      const sub = await latestSubscription(db, user.id);
      if (sub?.provider !== PROVIDER || !(await currentToken())) return sendError(reply, 404, "no_subscription", "No tienes una suscripción.");
      const session = await polar<{ customer_portal_url?: string }>(
        "/v1/customer-sessions/",
        { external_customer_id: user.id, return_url: `${webOrigin(request.headers.origin)}/dashboard/planes` },
        request.log,
      );
      if (!session?.customer_portal_url) return sendError(reply, 502, "portal_failed", "No se pudo abrir la suscripción. Intenta de nuevo.");
      return { url: session.customer_portal_url };
    });

    // Avisos de Polar (públicos, sin sesión): la firma prueba que vienen de Polar. El cuerpo se
    // necesita tal cual llegó para comprobarla.
    await app.register(async (hooks) => {
      hooks.removeContentTypeParser("application/json");
      hooks.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, String(body)));
      hooks.post("/billing/polar-webhook", async (request, reply) => {
        let stored = await currentWebhookSecret();
        let secret = polarWebhookSecret(stored);
        if (!secret) {
          request.log.warn("aviso de Polar sin aplicar: falta la clave de los avisos en Secrets Manager");
          return sendError(reply, 503, "billing_not_configured", "Pagos no configurados.");
        }
        const raw = typeof request.body === "string" ? request.body : "";
        const header = (name: string) => {
          const v = request.headers[name];
          return Array.isArray(v) ? v[0] : v;
        };
        const signed = {
          id: header("webhook-id"),
          timestamp: header("webhook-timestamp"),
          signature: header("webhook-signature"),
        };
        let valid = verifyPolarSignature(raw, signed, secret);
        if (!valid && liveSecrets.webhookSecret) {
          // Quizá la clave se acaba de cambiar en Secrets Manager: se relee y se prueba una vez más.
          stored = await currentWebhookSecret(true);
          secret = polarWebhookSecret(stored);
          valid = Boolean(secret) && verifyPolarSignature(raw, signed, secret!);
        }
        if (!valid) {
          // Nunca se registra la clave: solo su forma, para saber si se pegó mal.
          request.log.warn({ clave: describeStoredSecret(stored) }, "aviso de Polar con firma inválida");
          return sendError(reply, 403, "invalid_signature", "Firma inválida.");
        }
        let payload: unknown;
        try {
          payload = JSON.parse(raw);
        } catch {
          return sendError(reply, 400, "invalid_json", "El cuerpo no es JSON válido.");
        }
        try {
          await applyPolarEvent(db, settings, payload, request.log);
        } catch (err) {
          // Polar reintenta los avisos que no reciben 2xx (p. ej. si el pago llegó antes que el usuario).
          if (err instanceof RetryLater) {
            request.log.warn({ reason: err.message }, "aviso de Polar sin aplicar");
            return sendError(reply, 503, "not_applied", "No se pudo aplicar el aviso.");
          }
          // Formato que no se entiende: reintentarlo no lo arregla, y Polar apaga la dirección tras muchos fallos.
          if (err instanceof z.ZodError) {
            request.log.warn({ reason: "formato inesperado" }, "aviso de Polar sin aplicar");
            return reply.code(202).send({ ok: false });
          }
          throw err;
        }
        return reply.code(202).send({ ok: true });
      });
    });
  };
}
