import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@clipflow/shared/db";
import { paddleWebhookSecret, verifyPaddleSignature, type BillingSettings } from "./billing.js";
import { bearer, closeTestApp, createTestApp, type TestContext } from "./test-helpers.js";

const SECRET = "pdl_ntfset_01testtesttesttest_abcdefabcdef";
const settings: BillingSettings = {
  BILLING_ENABLED: true,
  BILLING_FREE_EMAILS: "Dueno@example.com",
  PADDLE_ENVIRONMENT: "sandbox",
  PADDLE_CLIENT_TOKEN: "test_0123456789abcdef",
  PADDLE_PRICE_TRIAL_FEE: "pri_fee",
  PADDLE_PRICE_BASIC: "pri_basic",
  PADDLE_PRICE_PRO: "pri_pro",
  PADDLE_PRICE_MAX: "pri_max",
  PADDLE_PORTAL_URL: "https://customer-portal.paddle.com/cpl_test",
  PADDLE_WEBHOOK_SECRET: SECRET,
};

let ctx: TestContext | undefined;
afterEach(async () => {
  await closeTestApp(ctx);
  ctx = undefined;
});
const app = () => ctx!.app;

function sign(body: string, ts = Math.floor(Date.now() / 1000)) {
  return `ts=${ts};h1=${createHmac("sha256", SECRET).update(`${ts}:${body}`).digest("hex")}`;
}
let n = 0;
function webhook(eventType: string, data: Record<string, unknown>, occurredAt = new Date().toISOString()) {
  const body = JSON.stringify({ event_id: `evt_${++n}`, event_type: eventType, occurred_at: occurredAt, data });
  return app().inject({
    method: "POST",
    url: "/billing/paddle-webhook",
    headers: { "content-type": "application/json", "paddle-signature": sign(body) },
    payload: body,
  });
}
const me = async (sub: string) => (await app().inject({ method: "GET", url: "/me", headers: bearer(sub) })).json();
const billing = async (sub: string) => (await app().inject({ method: "GET", url: "/billing", headers: bearer(sub) })).json();
const newProject = async (sub: string) =>
  (await app().inject({ method: "POST", url: "/projects", headers: bearer(sub), payload: { name: "P" } })).json().id as string;
const startUpload = async (sub: string) =>
  app().inject({
    method: "POST",
    url: "/videos",
    headers: bearer(sub),
    payload: { projectId: await newProject(sub), filename: "v.mp4", mimeType: "video/mp4", sizeBytes: 1000, durationSeconds: 60 },
  });

describe("pagos con Paddle", () => {
  it("firma: solo acepta avisos firmados con la clave y recientes", () => {
    const body = '{"a":1}';
    expect(verifyPaddleSignature(body, sign(body), SECRET)).toBe(true);
    expect(verifyPaddleSignature('{"a":2}', sign(body), SECRET)).toBe(false);
    expect(verifyPaddleSignature(body, sign(body, Math.floor(Date.now() / 1000) - 3600), SECRET)).toBe(false);
    expect(verifyPaddleSignature(body, undefined, SECRET)).toBe(false);
  });

  it("la clave de los avisos se acepta pegada sola, con comillas o en la pestaña Key/value de AWS", () => {
    expect(paddleWebhookSecret(SECRET)).toBe(SECRET);
    expect(paddleWebhookSecret(` "${SECRET}" `)).toBe(SECRET);
    expect(paddleWebhookSecret(JSON.stringify({ secret: SECRET }))).toBe(SECRET);
    expect(paddleWebhookSecret("Ab3$kL9!mN2#pQ5%rS8&tU1*vW4^xY7(")).toBeNull();
    expect(paddleWebhookSecret(undefined)).toBeNull();
    // Cualquier carácter visible después del prefijo (no solo letras y números).
    expect(paddleWebhookSecret("pdl_ntfset_01abc-DEF+ghi/JKL=xyz")).toBe("pdl_ntfset_01abc-DEF+ghi/JKL=xyz");
    expect(paddleWebhookSecret(`Secret key: ${SECRET}\n`)).toBe(SECRET);
    expect(paddleWebhookSecret(SECRET.replace("pdl_", "Pdl_"))).toBe(SECRET);
  });

  it("sin pagos activados se procesa sin plan (como hasta ahora)", async () => {
    ctx = await createTestApp();
    expect((await startUpload("alice")).statusCode).toBe(201);
    expect(await billing("alice")).toMatchObject({ enabled: false, checkout: null });
  });

  it("prueba (pago único) → 60 min por 7 días y vence sola; Básico → 200 min; cancelado → 0 y se bloquea", async () => {
    ctx = await createTestApp(undefined, settings);
    const { userId } = await me("alice");

    // Sin plan: no deja empezar; ofrece la prueba (pago único de 1.99 USD) y los tres planes.
    const blocked = await startUpload("alice");
    expect(blocked.statusCode).toBe(402);
    expect(blocked.json().error.code).toBe("no_plan");
    expect(await billing("alice")).toMatchObject({
      enabled: true,
      trialEligible: true,
      checkout: {
        environment: "sandbox",
        options: [
          { plan: "trial", items: [{ priceId: "pri_fee", quantity: 1 }] },
          { plan: "basic", items: [{ priceId: "pri_basic", quantity: 1 }] },
          { plan: "pro", items: [{ priceId: "pri_pro", quantity: 1 }] },
          { plan: "max", items: [{ priceId: "pri_max", quantity: 1 }] },
        ],
        customData: { userId },
        email: "alice@example.com",
      },
    });

    // Firma inválida: no cambia nada.
    const forged = await app().inject({
      method: "POST",
      url: "/billing/paddle-webhook",
      headers: { "content-type": "application/json", "paddle-signature": "ts=1;h1=00" },
      payload: "{}",
    });
    expect(forged.statusCode).toBe(401);

    // Pago de la prueba: sin suscripción en Paddle. Repetido no carga dos veces ni duplica la prueba.
    const trialPaid = { id: "txn_1", subscription_id: null, custom_data: { userId }, items: [{ price: { id: "pri_fee" } }] };
    expect((await webhook("transaction.completed", trialPaid)).statusCode).toBe(200);
    expect((await webhook("transaction.completed", trialPaid)).statusCode).toBe(200);
    const trial = await billing("alice");
    expect(trial).toMatchObject({
      creditMinutes: 60,
      trialEligible: false,
      subscription: { planCode: "trial", status: "trialing", cancelAtPeriodEnd: false },
      checkout: { options: [{ plan: "basic" }, { plan: "pro" }, { plan: "max" }] },
    });
    const days = (new Date(trial.subscription.currentPeriodEnd).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    expect((await startUpload("alice")).statusCode).toBe(201);

    // A los 7 días vence sola (Paddle no avisa): ya no deja procesar.
    await ctx.database.db
      .update(schema.subscriptions)
      .set({ currentPeriodEnd: new Date(Date.now() - 1000) })
      .where(eq(schema.subscriptions.providerSubscriptionId, "txn_1"));
    expect((await billing("alice")).subscription.status).toBe("expired");
    expect((await startUpload("alice")).json().error.code).toBe("no_plan");

    // Elige Básico. El pago llega antes que la suscripción (Paddle no garantiza el orden) → 200 min.
    const sub = {
      id: "sub_1",
      status: "active",
      customer_id: "ctm_1",
      custom_data: { userId },
      items: [{ price: { id: "pri_basic" } }],
      current_billing_period: { starts_at: "2026-10-16T00:00:00Z", ends_at: "2026-11-16T00:00:00Z" },
      scheduled_change: null,
    };
    await webhook("transaction.completed", { id: "txn_2", subscription_id: "sub_1", custom_data: { userId }, items: [{ price_id: "pri_basic" }] });
    expect((await webhook("subscription.created", sub)).statusCode).toBe(200);
    expect(await billing("alice")).toMatchObject({
      creditMinutes: 200,
      subscription: { planCode: "basic", status: "active", currentPeriodEnd: "2026-11-16T00:00:00.000Z" },
    });
    expect((await startUpload("alice")).statusCode).toBe(201);

    // Renovación sin customData (se reconoce por la suscripción) después de cambiar a Max → 1000 min.
    await webhook("subscription.updated", { ...sub, custom_data: null, items: [{ price: { id: "pri_max" } }] });
    await webhook("transaction.completed", { id: "txn_3", subscription_id: "sub_1", items: [{ price_id: "pri_max" }] });
    expect(await billing("alice")).toMatchObject({ creditMinutes: 1000, subscription: { planCode: "max" } });

    // Un aviso viejo que llega tarde no pisa el estado.
    await webhook("subscription.updated", { ...sub, status: "past_due" }, "2020-01-01T00:00:00Z");
    expect((await billing("alice")).subscription.status).toBe("active");

    // Cancela al final del periodo: sigue activo hasta entonces.
    await webhook("subscription.updated", { ...sub, items: [{ price: { id: "pri_max" } }], scheduled_change: { action: "cancel" } });
    expect((await billing("alice")).subscription).toMatchObject({ status: "active", cancelAtPeriodEnd: true });
    await webhook("subscription.canceled", { ...sub, status: "canceled", scheduled_change: null });
    expect(await billing("alice")).toMatchObject({ creditMinutes: 0, subscription: { status: "canceled" } });
    expect((await startUpload("alice")).json().error.code).toBe("no_plan");

    // La prueba y la suscripción: dos filas.
    const rows = await ctx.database.db.select().from(schema.subscriptions).where(eq(schema.subscriptions.userId, userId));
    expect(rows).toHaveLength(2);
  });

  it("con plan pero sin minutos: avisa que se acabaron; el correo exento no necesita plan", async () => {
    ctx = await createTestApp(undefined, settings);
    const { userId } = await me("bob");
    await webhook("subscription.created", { id: "sub_b", status: "active", custom_data: { userId }, items: [{ price: { id: "pri_pro" } }] });
    const res = await startUpload("bob");
    expect(res.statusCode).toBe(402);
    expect(res.json().error.code).toBe("no_minutes");

    await me("dueno");
    expect((await startUpload("dueno")).statusCode).toBe(201);
    expect(await billing("dueno")).toMatchObject({ exempt: true });
  });

  it("avisos simultáneos de la misma suscripción no chocan; un precio de prueba con renovación se ve como prueba", async () => {
    ctx = await createTestApp(undefined, settings);
    const { userId } = await me("carla");
    const sub = { id: "sub_c", status: "active", custom_data: { userId }, items: [{ price: { id: "pri_fee" } }] };
    const results = await Promise.all([webhook("subscription.created", sub), webhook("subscription.activated", sub)]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    await webhook("transaction.completed", { id: "txn_c", subscription_id: "sub_c", custom_data: { userId }, items: [{ price: { id: "pri_fee" } }] });
    expect(await billing("carla")).toMatchObject({ creditMinutes: 60, subscription: { planCode: "trial", status: "active" } });
  });

  it("un pago de un usuario que no existe se reintenta más tarde (no se pierde)", async () => {
    ctx = await createTestApp(undefined, settings);
    const res = await webhook("transaction.completed", { id: "txn_x", subscription_id: "sub_x", custom_data: null, items: [{ price: { id: "pri_pro" } }] });
    expect(res.statusCode).toBe(503);
  });
});
