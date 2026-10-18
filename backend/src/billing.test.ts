import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@clipflow/shared/db";
import { polarAccessToken, polarWebhookSecret, verifyPolarSignature, type BillingSettings } from "./billing.js";
import { bearer, closeTestApp, createTestApp, type TestContext } from "./test-helpers.js";

const SECRET = "polar_whs_testtesttesttesttesttest";
const settings: BillingSettings = {
  BILLING_ENABLED: true,
  BILLING_FREE_EMAILS: "Dueno@example.com",
  POLAR_SERVER: "sandbox",
  POLAR_PRODUCT_BASIC: "prod-basic",
  POLAR_PRODUCT_PRO: "prod-pro",
  POLAR_PRODUCT_MAX: "prod-max",
  POLAR_ACCESS_TOKEN: "polar_oat_0123456789abcdef",
  POLAR_WEBHOOK_SECRET: SECRET,
};

/** Polar falso: guarda lo que se le pidió y responde con un enlace. */
function fakePolar() {
  const calls: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body });
    const json = String(url).endsWith("/v1/checkouts/")
      ? { id: "co_1", url: "https://sandbox.polar.sh/checkout/co_1" }
      : { customer_portal_url: "https://sandbox.polar.sh/portal/x" };
    return new Response(JSON.stringify(json), { status: 201, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

let ctx: TestContext | undefined;
afterEach(async () => {
  await closeTestApp(ctx);
  ctx = undefined;
});
const app = () => ctx!.app;

function sign(id: string, body: string, ts = Math.floor(Date.now() / 1000), key: Buffer | string = SECRET) {
  return { id, ts: String(ts), sig: `v1,${createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64")}` };
}
let n = 0;
function webhook(type: string, data: Record<string, unknown>, timestamp = new Date().toISOString()) {
  const body = JSON.stringify({ type, timestamp, data });
  const s = sign(`msg_${++n}`, body);
  return app().inject({
    method: "POST",
    url: "/billing/polar-webhook",
    headers: { "content-type": "application/json", "webhook-id": s.id, "webhook-timestamp": s.ts, "webhook-signature": s.sig },
    payload: body,
  });
}
const me = async (sub: string) => (await app().inject({ method: "GET", url: "/me", headers: bearer(sub) })).json();
const billing = async (sub: string) => (await app().inject({ method: "GET", url: "/billing", headers: bearer(sub) })).json();
const checkout = (sub: string, plan: string) =>
  app().inject({ method: "POST", url: "/billing/checkout", headers: { ...bearer(sub), origin: "http://localhost:3000" }, payload: { plan } });
const newProject = async (sub: string) =>
  (await app().inject({ method: "POST", url: "/projects", headers: bearer(sub), payload: { name: "P" } })).json().id as string;
const startUpload = async (sub: string) =>
  app().inject({
    method: "POST",
    url: "/videos",
    headers: bearer(sub),
    payload: { projectId: await newProject(sub), filename: "v.mp4", mimeType: "video/mp4", sizeBytes: 1000, durationSeconds: 60 },
  });

describe("pagos con Polar", () => {
  it("firma: solo acepta avisos firmados con la clave y recientes (también claves whsec_ en base64)", () => {
    const body = '{"a":1}';
    const ok = sign("m1", body);
    expect(verifyPolarSignature(body, { id: "m1", timestamp: ok.ts, signature: ok.sig }, SECRET)).toBe(true);
    expect(verifyPolarSignature('{"a":2}', { id: "m1", timestamp: ok.ts, signature: ok.sig }, SECRET)).toBe(false);
    expect(verifyPolarSignature(body, { id: "m2", timestamp: ok.ts, signature: ok.sig }, SECRET)).toBe(false);
    const old = sign("m1", body, Math.floor(Date.now() / 1000) - 3600);
    expect(verifyPolarSignature(body, { id: "m1", timestamp: old.ts, signature: old.sig }, SECRET)).toBe(false);
    expect(verifyPolarSignature(body, { id: "m1", timestamp: ok.ts }, SECRET)).toBe(false);
    // Varias firmas en la cabecera: basta una válida.
    expect(verifyPolarSignature(body, { id: "m1", timestamp: ok.ts, signature: `v1,AAAA ${ok.sig}` }, SECRET)).toBe(true);
    // Clave whsec_: se firma con el texto tal cual o con su forma en base64.
    const whsec = `whsec_${Buffer.from("clave-de-prueba-123").toString("base64")}`;
    const asText = sign("m1", body, undefined, whsec);
    const asBytes = sign("m1", body, undefined, Buffer.from("clave-de-prueba-123"));
    expect(verifyPolarSignature(body, { id: "m1", timestamp: asText.ts, signature: asText.sig }, whsec)).toBe(true);
    expect(verifyPolarSignature(body, { id: "m1", timestamp: asBytes.ts, signature: asBytes.sig }, whsec)).toBe(true);
  });

  it("las claves se aceptan pegadas solas, con comillas o en la pestaña Key/value de AWS", () => {
    expect(polarAccessToken("polar_oat_0123456789abcdef")).toBe("polar_oat_0123456789abcdef");
    expect(polarAccessToken(' "polar_oat_0123456789abcdef" ')).toBe("polar_oat_0123456789abcdef");
    expect(polarAccessToken(JSON.stringify({ token: "polar_oat_0123456789abcdef" }))).toBe("polar_oat_0123456789abcdef");
    // El relleno de AWS no es un token: los pagos quedan apagados.
    expect(polarAccessToken("Ab3kL9mN2pQ5rS8tU1vW4xY7")).toBeNull();
    expect(polarAccessToken(undefined)).toBeNull();
    expect(polarWebhookSecret(` "${SECRET}"\n`)).toBe(SECRET);
    expect(polarWebhookSecret(JSON.stringify({ secret: SECRET }))).toBe(SECRET);
    expect(polarWebhookSecret("  ")).toBeNull();
  });

  it("sin pagos activados se procesa sin plan (como hasta ahora)", async () => {
    ctx = await createTestApp();
    expect((await startUpload("alice")).statusCode).toBe(201);
    expect(await billing("alice")).toMatchObject({ enabled: false, checkoutReady: false });
  });

  it("prueba gratis de 7 días (60 min) → pasa sola al Básico (200 min) → cancela y vence → 0", async () => {
    const polar = fakePolar();
    ctx = await createTestApp(undefined, settings, { billingFetch: polar.fetch });
    const { userId } = await me("alice");

    // Sin plan: no deja empezar; ofrece el Básico con la prueba gratis.
    const blocked = await startUpload("alice");
    expect(blocked.statusCode).toBe(402);
    expect(blocked.json().error.code).toBe("no_plan");
    expect(await billing("alice")).toMatchObject({ enabled: true, trialEligible: true, checkoutReady: true, portalAvailable: false });

    // Abre el pago del Básico con 7 días gratis, con su usuario y volviendo a la web.
    const res = await checkout("alice", "basic");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: "https://sandbox.polar.sh/checkout/co_1" });
    expect(polar.calls[0]).toMatchObject({
      url: "https://sandbox-api.polar.sh/v1/checkouts/",
      auth: "Bearer polar_oat_0123456789abcdef",
      body: {
        products: ["prod-basic"],
        external_customer_id: userId,
        customer_email: "alice@example.com",
        metadata: { userId, plan: "basic" },
        success_url: "http://localhost:3000/dashboard/planes?pago=ok",
        allow_trial: true,
        trial_interval: "day",
        trial_interval_count: 7,
      },
    });
    expect((await checkout("alice", "gratis")).statusCode).toBe(400);

    // Firma inválida: no cambia nada.
    const forged = await app().inject({
      method: "POST",
      url: "/billing/polar-webhook",
      headers: { "content-type": "application/json", "webhook-id": "x", "webhook-timestamp": "1", "webhook-signature": "v1,AAAA" },
      payload: "{}",
    });
    expect(forged.statusCode).toBe(403);

    // Empieza la prueba: 60 min. Los avisos repetidos no cargan dos veces.
    const sub = {
      id: "sub_1",
      status: "trialing",
      product_id: "prod-basic",
      customer_id: "cus_1",
      customer: { id: "cus_1", external_id: userId },
      metadata: { userId },
      current_period_start: "2026-10-18T00:00:00Z",
      current_period_end: "2026-10-25T00:00:00Z",
      cancel_at_period_end: false,
    };
    expect((await webhook("subscription.created", sub)).statusCode).toBe(202);
    // El primer pedido de la prueba es de 0 USD: no carga minutos.
    await webhook("order.paid", { id: "ord_0", total_amount: 0, billing_reason: "subscription_create", product_id: "prod-basic", subscription_id: "sub_1", customer: { external_id: userId } });
    expect((await webhook("subscription.updated", sub)).statusCode).toBe(202);
    expect(await billing("alice")).toMatchObject({
      creditMinutes: 60,
      trialEligible: false,
      portalAvailable: true,
      subscription: { planCode: "trial", status: "trialing", currentPeriodEnd: "2026-10-25T00:00:00.000Z" },
    });
    expect((await startUpload("alice")).statusCode).toBe(201);
    // Ya tiene plan: no abre otro pago (se cambia desde Gestionar suscripción).
    expect((await checkout("alice", "pro")).statusCode).toBe(409);
    const portal = await app().inject({ method: "POST", url: "/billing/portal", headers: bearer("alice") });
    expect(portal.json()).toEqual({ url: "https://sandbox.polar.sh/portal/x" });
    expect(polar.calls.at(-1)!.body).toMatchObject({ external_customer_id: userId });

    // Pasada la fecha, la prueba no vence sola: espera el aviso de Polar.
    await ctx.database.db
      .update(schema.subscriptions)
      .set({ currentPeriodEnd: new Date(Date.now() - 1000) })
      .where(eq(schema.subscriptions.providerSubscriptionId, "sub_1"));
    expect((await billing("alice")).subscription.status).toBe("trialing");

    // Termina la prueba: Polar cobra el Básico (sin metadata, se reconoce por la suscripción) → 200 min.
    const paid = { id: "ord_1", total_amount: 999, billing_reason: "subscription_cycle", product_id: "prod-basic", subscription_id: "sub_1" };
    expect((await webhook("order.paid", paid)).statusCode).toBe(202);
    expect((await webhook("order.paid", paid)).statusCode).toBe(202);
    const active = { ...sub, status: "active", customer: null, metadata: {}, current_period_start: "2026-10-25T00:00:00Z", current_period_end: "2026-11-25T00:00:00Z" };
    await webhook("subscription.cycled", active);
    expect(await billing("alice")).toMatchObject({ creditMinutes: 200, subscription: { planCode: "basic", status: "active" } });

    // Cambia a Max: su cobro → 1000 min.
    await webhook("subscription.updated", { ...active, product_id: "prod-max" });
    await webhook("order.paid", { ...paid, id: "ord_2", total_amount: 3999, billing_reason: "subscription_update", product_id: "prod-max" });
    expect(await billing("alice")).toMatchObject({ creditMinutes: 1000, subscription: { planCode: "max" } });

    // Un aviso viejo que llega tarde no pisa el estado.
    await webhook("subscription.updated", { ...active, status: "past_due" }, "2020-01-01T00:00:00Z");
    expect((await billing("alice")).subscription.status).toBe("active");

    // Cancela: sigue activo hasta el fin del periodo; al terminar (revoked) se acaban los minutos.
    await webhook("subscription.canceled", { ...active, product_id: "prod-max", cancel_at_period_end: true });
    expect((await billing("alice")).subscription).toMatchObject({ status: "active", cancelAtPeriodEnd: true });
    await webhook("subscription.revoked", { ...active, product_id: "prod-max", status: "canceled", ended_at: "2026-11-25T00:00:00Z" });
    expect(await billing("alice")).toMatchObject({ creditMinutes: 0, subscription: { status: "canceled" } });
    expect((await startUpload("alice")).json().error.code).toBe("no_plan");

    // Ya usó la prueba: el Básico de nuevo se cobra desde el primer día.
    expect((await checkout("alice", "basic")).statusCode).toBe(200);
    expect(polar.calls.at(-1)!.body).toMatchObject({ allow_trial: false });
    expect(polar.calls.at(-1)!.body).not.toHaveProperty("trial_interval");
  });

  it("Pro directo: sin prueba; con plan pero sin minutos avisa; el correo exento no necesita plan", async () => {
    const polar = fakePolar();
    ctx = await createTestApp(undefined, settings, { billingFetch: polar.fetch });
    const { userId } = await me("bob");
    await checkout("bob", "pro");
    expect(polar.calls[0]!.body).toMatchObject({ products: ["prod-pro"], allow_trial: false });
    await webhook("subscription.created", { id: "sub_b", status: "active", product_id: "prod-pro", customer: { external_id: userId } });
    const res = await startUpload("bob");
    expect(res.statusCode).toBe(402);
    expect(res.json().error.code).toBe("no_minutes");
    await webhook("order.paid", { id: "ord_b", total_amount: 1999, billing_reason: "subscription_create", product_id: "prod-pro", subscription_id: "sub_b", metadata: { userId } });
    expect(await billing("bob")).toMatchObject({ creditMinutes: 400, subscription: { planCode: "pro", status: "active" } });

    await me("dueno");
    expect((await startUpload("dueno")).statusCode).toBe(201);
    expect(await billing("dueno")).toMatchObject({ exempt: true });
  });

  it("avisos simultáneos no chocan; productos ajenos y formatos raros se ignoran sin reintentos", async () => {
    ctx = await createTestApp(undefined, settings);
    const { userId } = await me("carla");
    const sub = { id: "sub_c", status: "trialing", product_id: "prod-basic", customer: { external_id: userId } };
    const results = await Promise.all([webhook("subscription.created", sub), webhook("subscription.active", sub)]);
    expect(results.map((r) => r.statusCode)).toEqual([202, 202]);
    expect(await billing("carla")).toMatchObject({ creditMinutes: 60, subscription: { planCode: "trial" } });

    expect((await webhook("subscription.created", { ...sub, id: "sub_z", product_id: "otro" })).statusCode).toBe(202);
    expect((await webhook("order.paid", { sin: "id" })).statusCode).toBe(202);
    expect((await webhook("checkout.created", { id: "co" })).statusCode).toBe(202);
    const rows = await ctx.database.db.select().from(schema.subscriptions).where(eq(schema.subscriptions.userId, userId));
    expect(rows).toHaveLength(1);
  });

  it("un pago de un usuario que no existe se reintenta más tarde (no se pierde)", async () => {
    ctx = await createTestApp(undefined, settings);
    const res = await webhook("order.paid", { id: "ord_x", total_amount: 999, billing_reason: "subscription_cycle", product_id: "prod-pro", subscription_id: "sub_x" });
    expect(res.statusCode).toBe(503);
  });

  it("sin token de Polar los pagos no se abren", async () => {
    ctx = await createTestApp(undefined, { ...settings, POLAR_ACCESS_TOKEN: "relleno-de-aws" });
    await me("dani");
    expect(await billing("dani")).toMatchObject({ checkoutReady: false });
    expect((await checkout("dani", "basic")).statusCode).toBe(503);
  });
});
