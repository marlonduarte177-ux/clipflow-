import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, preHandlerHookHandler } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  isBillingExempt,
  NO_MINUTES_CODE,
  NO_MINUTES_MESSAGE,
  NO_PLAN_CODE,
  NO_PLAN_MESSAGE,
  MONTHLY_PLANS,
  PLANS,
  type BillingResponse,
  type BillingStatus,
  type MonthlyPlanCode,
  type PlanCode,
} from "@clipflow/shared";
import {
  getCreditBalance,
  latestSubscription,
  schema,
  setPlanMinutes,
  subscriptionAllowsProcessing,
  type Database,
} from "@clipflow/shared/db";
import type { AuthUser } from "./auth.js";
import type { ApiConfig } from "./config.js";
import { sendError } from "./http.js";

const { subscriptions, users } = schema;

export type BillingSettings = Pick<
  ApiConfig,
  | "BILLING_ENABLED"
  | "BILLING_FREE_EMAILS"
  | "PADDLE_ENVIRONMENT"
  | "PADDLE_CLIENT_TOKEN"
  | "PADDLE_PRICE_TRIAL_FEE"
  | "PADDLE_PRICE_BASIC_TRIAL"
  | "PADDLE_PRICE_BASIC"
  | "PADDLE_PRICE_PRO"
  | "PADDLE_PRICE_MAX"
  | "PADDLE_DISCOUNT_TRIAL"
  | "PADDLE_PORTAL_URL"
  | "PADDLE_WEBHOOK_SECRET"
>;

/** Sin pagos (local y tests): se procesa sin plan. */
export const BILLING_OFF: BillingSettings = { BILLING_ENABLED: false, PADDLE_ENVIRONMENT: "sandbox" };

/** Una clave real de avisos de Paddle empieza por "pdl_ntfset_". El relleno de AWS no. */
export function looksLikePaddleWebhookSecret(value: string | undefined): value is string {
  return typeof value === "string" && /^pdl_ntfset_[A-Za-z0-9_]{10,}$/.test(value.trim());
}

/**
 * La clave de los avisos tal como se pegó en Secrets Manager. Acepta también la pestaña «Key/value»
 * de AWS (JSON con un solo valor) y comillas alrededor. null si no parece una clave de Paddle.
 */
export function paddleWebhookSecret(stored: string | undefined): string | null {
  // La clave puede venir sola, entre comillas, en JSON (pestaña Key/value de AWS) o con texto alrededor:
  // se toma el primer "pdl_ntfset_…" que aparezca (el prefijo, en minúsculas como lo entrega Paddle).
  const found = /pdl_ntfset_[^\s"',}]+/i.exec(stored ?? "");
  if (!found) return null;
  const value = `pdl_ntfset_${found[0].slice("pdl_ntfset_".length)}`;
  return looksLikePaddleWebhookSecret(value) ? value : null;
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
    contienePdl: /pdl/i.test(v),
    contieneNtfset: /ntfset/i.test(v),
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

/** Comprueba la firma de Paddle ("ts=…;h1=…"): HMAC-SHA256 de "ts:cuerpo" con la clave secreta. */
export function verifyPaddleSignature(rawBody: string, header: string | undefined, secret: string, nowMs = Date.now()): boolean {
  if (!header) return false;
  const parts = header.split(";").map((p) => p.trim().split("="));
  const ts = parts.find(([k]) => k === "ts")?.[1];
  const signatures = parts.filter(([k]) => k === "h1").map(([, v]) => v ?? "");
  if (!ts || !/^\d+$/.test(ts) || signatures.length === 0) return false;
  // Más de 5 minutos de diferencia: podría ser un aviso viejo reenviado por un tercero.
  if (Math.abs(nowMs / 1000 - Number(ts)) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${ts}:${rawBody}`).digest();
  return signatures.some((sig) => {
    const given = Buffer.from(sig, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

const PaddleItem = z.object({
  price_id: z.string().optional(),
  price: z.object({ id: z.string() }).nullish(),
});
const CustomData = z.object({ userId: z.string().optional() }).passthrough().nullish();
const PaddleEvent = z.object({
  event_id: z.string(),
  event_type: z.string(),
  occurred_at: z.string(),
  data: z.record(z.string(), z.unknown()),
});
const PaddleSubscription = z.object({
  id: z.string(),
  status: z.string(),
  customer_id: z.string().nullish(),
  custom_data: CustomData,
  items: z.array(PaddleItem).default([]),
  current_billing_period: z.object({ starts_at: z.string(), ends_at: z.string() }).nullish(),
  scheduled_change: z.object({ action: z.string() }).nullish(),
});
const PaddleTransaction = z.object({
  id: z.string(),
  subscription_id: z.string().nullish(),
  custom_data: CustomData,
  items: z.array(PaddleItem).default([]),
});

const priceIds = (items: z.infer<typeof PaddleItem>[]) =>
  items.map((i) => i.price?.id ?? i.price_id).filter((id): id is string => Boolean(id));

const STATUS: Record<string, BillingStatus> = {
  trialing: "trialing",
  active: "active",
  past_due: "past_due",
  canceled: "canceled",
  paused: "expired",
};

/** Dueño del pago: el que abrió el pago (customData) o el de la suscripción ya guardada. */
async function resolveUser(db: Database, customUserId: string | undefined, subscriptionId: string | null | undefined) {
  if (customUserId && z.uuid().safeParse(customUserId).success) {
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, customUserId));
    if (user) return user.id;
  }
  if (subscriptionId) {
    const [row] = await db
      .select({ userId: subscriptions.userId })
      .from(subscriptions)
      .where(and(eq(subscriptions.provider, "paddle"), eq(subscriptions.providerSubscriptionId, subscriptionId)));
    if (row) return row.userId;
  }
  return null;
}

export class RetryLater extends Error {}

/** Plan mensual de cada precio de Paddle (Básico con prueba también es Básico). */
function monthlyPlanOf(settings: BillingSettings, priceId: string): MonthlyPlanCode | null {
  if (priceId === settings.PADDLE_PRICE_BASIC || priceId === settings.PADDLE_PRICE_BASIC_TRIAL) return "basic";
  if (priceId === settings.PADDLE_PRICE_PRO) return "pro";
  if (priceId === settings.PADDLE_PRICE_MAX) return "max";
  return null;
}

/**
 * Aplica un aviso de Paddle. Idempotente: los avisos repetidos no cargan minutos dos veces y los
 * avisos viejos que llegan tarde no pisan el estado nuevo.
 */
export async function applyPaddleEvent(db: Database, settings: BillingSettings, raw: unknown, log: FastifyBaseLogger): Promise<void> {
  const event = PaddleEvent.parse(raw);
  const occurredAt = new Date(event.occurred_at);

  if (event.event_type.startsWith("subscription.")) {
    const sub = PaddleSubscription.parse(event.data);
    const userId = await resolveUser(db, sub.custom_data?.userId, sub.id);
    if (!userId) throw new RetryLater("suscripción sin usuario");
    const recurring = priceIds(sub.items).find((id) => monthlyPlanOf(settings, id)) ?? null;
    const status = STATUS[sub.status] ?? "expired";
    const planCode: PlanCode = status === "trialing" ? "trial" : (recurring && monthlyPlanOf(settings, recurring)) || "basic";
    const values = {
      userId,
      planCode,
      status,
      provider: "paddle",
      providerSubscriptionId: sub.id,
      providerCustomerId: sub.customer_id ?? null,
      priceId: recurring,
      providerEventAt: occurredAt,
      currentPeriodStart: sub.current_billing_period ? new Date(sub.current_billing_period.starts_at) : null,
      currentPeriodEnd: sub.current_billing_period ? new Date(sub.current_billing_period.ends_at) : null,
      cancelAtPeriodEnd: sub.scheduled_change?.action === "cancel",
    };
    const [existing] = await db
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.provider, "paddle"), eq(subscriptions.providerSubscriptionId, sub.id)));
    if (existing?.providerEventAt && existing.providerEventAt > occurredAt) return; // aviso viejo
    if (existing) await db.update(subscriptions).set(values).where(eq(subscriptions.id, existing.id));
    else await db.insert(subscriptions).values(values);
    // Terminó (canceló o no pagó): se acaban los minutos.
    if (status === "canceled" || status === "expired") {
      await setPlanMinutes(db, { userId, minutes: 0, eventId: `paddle:${sub.id}:${status}`, note: "plan terminado" });
    }
    log.info({ event: event.event_type, status }, "suscripción actualizada");
    return;
  }

  if (event.event_type === "transaction.completed") {
    const txn = PaddleTransaction.parse(event.data);
    if (!txn.subscription_id) return; // por ahora solo hay planes (sin paquetes sueltos)
    const userId = await resolveUser(db, txn.custom_data?.userId, txn.subscription_id);
    if (!userId) throw new RetryLater("pago sin usuario");
    const ids = priceIds(txn.items);
    // Pago de la prueba (1.99 USD) → 60 min. Pago de un plan mensual (primer mes o renovación) → sus minutos.
    const monthly = ids.map((id) => monthlyPlanOf(settings, id)).find(Boolean);
    const plan = settings.PADDLE_PRICE_TRIAL_FEE && ids.includes(settings.PADDLE_PRICE_TRIAL_FEE)
      ? PLANS.trial
      : monthly
        ? PLANS[monthly]
        : null;
    if (!plan) {
      log.warn({ event: event.event_type }, "pago con un precio que no es de ClipFlow: se ignora");
      return;
    }
    const applied = await setPlanMinutes(db, { userId, minutes: plan.minutes, eventId: `paddle:${txn.id}`, note: `plan ${plan.code}` });
    log.info({ event: event.event_type, plan: plan.code, applied }, "minutos del plan cargados");
  }
}

export interface BillingRouteDeps {
  db: Database;
  auth: preHandlerHookHandler;
  settings: BillingSettings;
}

export function billingRoutes({ db, auth, settings }: BillingRouteDeps) {
  const monthlyPrice: Record<MonthlyPlanCode, string | undefined> = {
    basic: settings.PADDLE_PRICE_BASIC,
    pro: settings.PADDLE_PRICE_PRO,
    max: settings.PADDLE_PRICE_MAX,
  };
  const checkoutReady = Boolean(
    settings.PADDLE_CLIENT_TOKEN &&
      settings.PADDLE_PRICE_TRIAL_FEE &&
      settings.PADDLE_PRICE_BASIC_TRIAL &&
      MONTHLY_PLANS.every((plan) => monthlyPrice[plan]),
  );

  return async (app: FastifyInstance) => {
    app.get("/billing", { preHandler: auth }, async (request): Promise<BillingResponse> => {
      const user = request.user!;
      const sub = await latestSubscription(db, user.id);
      const trialEligible = !sub;
      return {
        enabled: settings.BILLING_ENABLED,
        exempt: isBillingExempt(user.email, settings.BILLING_FREE_EMAILS),
        creditMinutes: await getCreditBalance(db, user.id),
        subscription: sub
          ? {
              planCode: (sub.planCode in PLANS ? sub.planCode : "basic") as PlanCode,
              status: sub.status,
              currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
              cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
            }
          : null,
        trialEligible,
        checkout: checkoutReady
          ? {
              environment: settings.PADDLE_ENVIRONMENT,
              clientToken: settings.PADDLE_CLIENT_TOKEN!,
              options: [
                ...(trialEligible
                  ? [
                      {
                        plan: "trial" as const,
                        items: [
                          { priceId: settings.PADDLE_PRICE_BASIC_TRIAL!, quantity: 1 },
                          { priceId: settings.PADDLE_PRICE_TRIAL_FEE!, quantity: 1 },
                        ],
                        // Los 1.99 de la prueba se descuentan del primer mes de Básico.
                        ...(settings.PADDLE_DISCOUNT_TRIAL ? { discountId: settings.PADDLE_DISCOUNT_TRIAL } : {}),
                      },
                    ]
                  : []),
                ...MONTHLY_PLANS.map((plan) => ({ plan, items: [{ priceId: monthlyPrice[plan]!, quantity: 1 }] })),
              ],
              customData: { userId: user.id },
              email: user.email,
            }
          : null,
        portalUrl: settings.PADDLE_PORTAL_URL || null,
      };
    });

    // Avisos de Paddle (públicos, sin sesión): la firma prueba que vienen de Paddle. El cuerpo se
    // necesita tal cual llegó para comprobarla.
    await app.register(async (hooks) => {
      hooks.removeContentTypeParser("application/json");
      hooks.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, String(body)));
      hooks.post("/billing/paddle-webhook", async (request, reply) => {
        const secret = paddleWebhookSecret(settings.PADDLE_WEBHOOK_SECRET);
        if (!secret) {
          // Nunca se registra la clave: solo que no tiene la forma esperada.
          request.log.warn(
            { clave: describeStoredSecret(settings.PADDLE_WEBHOOK_SECRET) },
            "aviso de Paddle sin aplicar: la clave de los avisos en Secrets Manager no empieza por pdl_ntfset_",
          );
          return sendError(reply, 503, "billing_not_configured", "Pagos no configurados.");
        }
        const raw = typeof request.body === "string" ? request.body : "";
        const header = request.headers["paddle-signature"];
        if (!verifyPaddleSignature(raw, Array.isArray(header) ? header[0] : header, secret)) {
          request.log.warn("aviso de Paddle con firma inválida");
          return sendError(reply, 401, "invalid_signature", "Firma inválida.");
        }
        let payload: unknown;
        try {
          payload = JSON.parse(raw);
        } catch {
          return sendError(reply, 400, "invalid_json", "El cuerpo no es JSON válido.");
        }
        try {
          await applyPaddleEvent(db, settings, payload, request.log);
        } catch (err) {
          // Paddle reintenta los avisos que no reciben 200 (p. ej. si el pago llegó antes que el usuario).
          if (err instanceof RetryLater || err instanceof z.ZodError) {
            request.log.warn({ reason: err instanceof RetryLater ? err.message : "formato inesperado" }, "aviso de Paddle sin aplicar");
            return sendError(reply, err instanceof RetryLater ? 503 : 400, "not_applied", "No se pudo aplicar el aviso.");
          }
          throw err;
        }
        return { ok: true };
      });
    });
  };
}
