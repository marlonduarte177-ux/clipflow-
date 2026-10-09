import { and, desc, eq, sql } from "drizzle-orm";
import type { Database, DbExecutor } from "./client.js";
import { getCreditBalance, InsufficientCreditsError } from "./ledger.js";
import { billingEvents, creditLedger, subscriptions, users } from "./schema.js";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Bloquea al usuario mientras cambia su saldo (dos movimientos a la vez no gastan el mismo saldo). */
async function lockUser(tx: Tx, userId: string): Promise<void> {
  const [owner] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
  if (!owner) throw new Error("El usuario no existe");
}

async function insertEntry(
  tx: Tx,
  entry: {
    userId: string;
    amount: number;
    balanceAfter: number;
    type: "subscription" | "processing" | "refund" | "adjustment";
    idempotencyKey: string;
    referenceType?: string;
    referenceId?: string;
    note?: string;
  },
) {
  await tx.insert(creditLedger).values(entry);
}

/** Lo cobrado y devuelto por un video: neto < 0 = ya está pagado. */
async function videoMovements(tx: Tx, userId: string, videoId: string) {
  const [row] = await tx
    .select({
      net: sql<number>`coalesce(sum(${creditLedger.amount}), 0)::int`,
      charges: sql<number>`count(*) filter (where ${creditLedger.amount} < 0)::int`,
      refunds: sql<number>`count(*) filter (where ${creditLedger.amount} > 0)::int`,
    })
    .from(creditLedger)
    .where(and(eq(creditLedger.userId, userId), eq(creditLedger.referenceType, "video"), eq(creditLedger.referenceId, videoId)));
  return { net: row?.net ?? 0, charges: row?.charges ?? 0, refunds: row?.refunds ?? 0 };
}

/**
 * Descuenta los minutos de un video al procesarlo. Un video ya pagado (y no devuelto) no se vuelve a
 * cobrar: volver a analizarlo o reintentarlo es gratis. Sin minutos suficientes lanza
 * InsufficientCreditsError y no descuenta nada. `run` identifica esta vuelta del trabajo (id y momento
 * en que entró a la cola): si falla, solo se devuelve lo que cobró esa vuelta.
 */
export async function chargeVideoMinutes(
  db: Database,
  input: { userId: string; videoId: string; run: string; minutes: number },
): Promise<{ charged: number; balance: number }> {
  if (!Number.isInteger(input.minutes) || input.minutes <= 0) throw new RangeError("minutes debe ser un entero > 0");
  return db.transaction(async (tx) => {
    await lockUser(tx, input.userId);
    const balance = await getCreditBalance(tx, input.userId);
    const moves = await videoMovements(tx, input.userId, input.videoId);
    if (moves.net < 0) return { charged: 0, balance };
    if (balance < input.minutes) throw new InsufficientCreditsError(balance, -input.minutes);
    await insertEntry(tx, {
      userId: input.userId,
      amount: -input.minutes,
      balanceAfter: balance - input.minutes,
      type: "processing",
      idempotencyKey: `video:${input.videoId}:charge:${moves.charges}`,
      referenceType: "video",
      referenceId: input.videoId,
      note: `trabajo ${input.run}`,
    });
    return { charged: input.minutes, balance: balance - input.minutes };
  });
}

/**
 * Devuelve lo que cobró la vuelta `run` de un trabajo que falló o se canceló (no lo pagado antes por
 * el mismo video, p. ej. al volver a analizarlo). Devuelve los minutos devueltos.
 */
export async function refundVideoMinutes(db: Database, input: { userId: string; videoId: string; run: string }): Promise<number> {
  return db.transaction(async (tx) => {
    await lockUser(tx, input.userId);
    const moves = await videoMovements(tx, input.userId, input.videoId);
    if (moves.net >= 0) return 0;
    const [lastCharge] = await tx
      .select({ note: creditLedger.note })
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.userId, input.userId),
          eq(creditLedger.referenceType, "video"),
          eq(creditLedger.referenceId, input.videoId),
          sql`${creditLedger.amount} < 0`,
        ),
      )
      .orderBy(desc(creditLedger.seq))
      .limit(1);
    if (lastCharge?.note !== `trabajo ${input.run}`) return 0;
    const balance = await getCreditBalance(tx, input.userId);
    await insertEntry(tx, {
      userId: input.userId,
      amount: -moves.net,
      balanceAfter: balance - moves.net,
      type: "refund",
      idempotencyKey: `video:${input.videoId}:refund:${moves.refunds}`,
      referenceType: "video",
      referenceId: input.videoId,
      note: "procesamiento fallido o cancelado",
    });
    return -moves.net;
  });
}

/**
 * Deja el saldo en `minutes` exactos (los minutos no se acumulan entre periodos). `eventId` identifica
 * el pago o el cambio (p. ej. "paddle:txn_…"): si el aviso se repite, no se aplica dos veces.
 * Devuelve false si ya se había aplicado.
 */
export async function setPlanMinutes(
  db: Database,
  input: { userId: string; minutes: number; eventId: string; note: string },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockUser(tx, input.userId);
    const inserted = await tx
      .insert(billingEvents)
      .values({ id: input.eventId, userId: input.userId })
      .onConflictDoNothing()
      .returning({ id: billingEvents.id });
    if (inserted.length === 0) return false;
    const balance = await getCreditBalance(tx, input.userId);
    const amount = input.minutes - balance;
    if (amount !== 0) {
      await insertEntry(tx, {
        userId: input.userId,
        amount,
        balanceAfter: input.minutes,
        type: amount > 0 ? "subscription" : "adjustment",
        idempotencyKey: `${input.eventId}:minutes`,
        referenceType: "billing",
        referenceId: input.eventId,
        note: input.note,
      });
    }
    return true;
  });
}

export type SubscriptionRow = typeof subscriptions.$inferSelect;

/** La suscripción más reciente del usuario (o undefined si nunca tuvo). */
export async function latestSubscription(db: DbExecutor, userId: string): Promise<SubscriptionRow | undefined> {
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);
  return row;
}

/**
 * Estado real del plan. La prueba es un pago único de 7 días: queda "trialing" en la base y vence sola
 * al pasar `currentPeriodEnd` (no hay aviso de Paddle cuando termina).
 */
export function effectiveStatus(row: SubscriptionRow, now = new Date()): SubscriptionRow["status"] {
  if (row.planCode === "trial" && row.status === "trialing" && row.currentPeriodEnd && row.currentPeriodEnd <= now) return "expired";
  return row.status;
}

/** ¿Puede crear clips? Plan en prueba (sin vencer), activo o con el cobro pendiente (Paddle reintenta). */
export function subscriptionAllowsProcessing(row: SubscriptionRow | undefined, now = new Date()): boolean {
  if (!row) return false;
  const status = effectiveStatus(row, now);
  return status === "trialing" || status === "active" || status === "past_due";
}
