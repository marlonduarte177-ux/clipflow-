import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@clipflow/shared/db";
import { verifyPaddleSignature, type BillingSettings } from "./billing.js";
import { bearer, closeTestApp, createTestApp, type TestContext } from "./test-helpers.js";

const SECRET = "pdl_ntfset_01testtesttesttest_abcdefabcdef";
const settings: BillingSettings = {
  BILLING_ENABLED: true,
  BILLING_FREE_EMAILS: "Dueno@example.com",
  PADDLE_ENVIRONMENT: "sandbox",
  PADDLE_CLIENT_TOKEN: "test_0123456789abcdef",
  PADDLE_PRICE_TRIAL_FEE: "pri_fee",
  PADDLE_PRICE_BASIC_TRIAL: "pri_basic_trial",
  PADDLE_PRICE_BASIC: "pri_basic",
  PADDLE_PRICE_PRO: "pri_pro",
  PADDLE_PRICE_MAX: "pri_max",
  PADDLE_DISCOUNT_TRIAL: "dsc_trial",
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

  it("sin pagos activados se procesa sin plan (como hasta ahora)", async () => {
    ctx = await createTestApp();
    expect((await startUpload("alice")).statusCode).toBe(201);
    expect(await billing("alice")).toMatchObject({ enabled: false, checkout: null });
  });

  it("prueba de 7 días → 60 min; pasa a Básico → 200 min; cancelado → 0 y se bloquea", async () => {
    ctx = await createTestApp(undefined, settings);
    const { userId } = await me("alice");

    // Sin plan: no deja empezar; ofrece la prueba (Básico con prueba + cargo de 1.99 USD) y los tres planes.
    const blocked = await startUpload("alice");
    expect(blocked.statusCode).toBe(402);
    expect(blocked.json().error.code).toBe("no_plan");
    expect(await billing("alice")).toMatchObject({
      enabled: true,
      trialEligible: true,
      checkout: {
        environment: "sandbox",
        options: [
          {
            plan: "trial",
            items: [
              { priceId: "pri_basic_trial", quantity: 1 },
              { priceId: "pri_fee", quantity: 1 },
            ],
            discountId: "dsc_trial",
          },
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

    // El pago llega antes que la suscripción (Paddle no garantiza el orden).
    const trialPaid = { id: "txn_1", subscription_id: "sub_1", custom_data: { userId }, items: [{ price: { id: "pri_basic_trial" } }, { price: { id: "pri_fee" } }] };
    expect((await webhook("transaction.completed", trialPaid)).statusCode).toBe(200);
    expect((await webhook("transaction.completed", trialPaid)).statusCode).toBe(200); // repetido
    const sub = {
      id: "sub_1",
      status: "trialing",
      customer_id: "ctm_1",
      custom_data: { userId },
      items: [{ price: { id: "pri_basic_trial" } }],
      current_billing_period: { starts_at: "2026-10-08T00:00:00Z", ends_at: "2026-10-15T00:00:00Z" },
      scheduled_change: null,
    };
    expect((await webhook("subscription.created", sub)).statusCode).toBe(200);
    expect(await billing("alice")).toMatchObject({
      creditMinutes: 60,
      trialEligible: false,
      subscription: { planCode: "trial", status: "trialing", currentPeriodEnd: "2026-10-15T00:00:00.000Z", cancelAtPeriodEnd: false },
      checkout: { options: [{ plan: "basic" }, { plan: "pro" }, { plan: "max" }] },
    });
    expect((await startUpload("alice")).statusCode).toBe(201);

    // Fin de la prueba: cobra Básico (sin customData: se reconoce por la suscripción) → 200.
    await webhook("subscription.updated", { ...sub, status: "active", custom_data: null });
    await webhook("transaction.completed", { id: "txn_2", subscription_id: "sub_1", items: [{ price_id: "pri_basic_trial" }] });
    expect(await billing("alice")).toMatchObject({ creditMinutes: 200, subscription: { planCode: "basic", status: "active" } });

    // Cambia a Max: el siguiente pago deja 1000 min.
    await webhook("subscription.updated", { ...sub, status: "active", items: [{ price: { id: "pri_max" } }] });
    await webhook("transaction.completed", { id: "txn_3", subscription_id: "sub_1", items: [{ price_id: "pri_max" }] });
    expect(await billing("alice")).toMatchObject({ creditMinutes: 1000, subscription: { planCode: "max" } });

    // Un aviso viejo que llega tarde no pisa el estado.
    await webhook("subscription.updated", sub, "2020-01-01T00:00:00Z");
    expect((await billing("alice")).subscription.status).toBe("active");

    // Cancela al final del periodo: sigue activo hasta entonces.
    await webhook("subscription.updated", { ...sub, status: "active", items: [{ price: { id: "pri_max" } }], scheduled_change: { action: "cancel" } });
    expect((await billing("alice")).subscription).toMatchObject({ status: "active", cancelAtPeriodEnd: true });
    await webhook("subscription.canceled", { ...sub, status: "canceled", scheduled_change: null });
    expect(await billing("alice")).toMatchObject({ creditMinutes: 0, subscription: { status: "canceled" } });
    expect((await startUpload("alice")).json().error.code).toBe("no_plan");

    const rows = await ctx.database.db.select().from(schema.subscriptions).where(eq(schema.subscriptions.userId, userId));
    expect(rows).toHaveLength(1);
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

  it("un pago de un usuario que no existe se reintenta más tarde (no se pierde)", async () => {
    ctx = await createTestApp(undefined, settings);
    const res = await webhook("transaction.completed", { id: "txn_x", subscription_id: "sub_x", custom_data: null, items: [{ price: { id: "pri_pro" } }] });
    expect(res.statusCode).toBe(503);
  });
});
