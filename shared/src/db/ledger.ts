import { desc, eq } from "drizzle-orm";
import type { Database, DbExecutor } from "./client.js";
import { creditLedger, ledgerEntryType, users } from "./schema.js";

export type LedgerEntry = typeof creditLedger.$inferSelect;
export type LedgerEntryType = (typeof ledgerEntryType.enumValues)[number];

export interface LedgerEntryInput {
  userId: string;
  /** > 0 suma créditos, < 0 los consume. Nunca 0. */
  amount: number;
  type: LedgerEntryType;
  /** Clave única del movimiento: repetir la misma operación no la duplica. */
  idempotencyKey: string;
  referenceType?: string;
  referenceId?: string;
  note?: string;
}

export class InsufficientCreditsError extends Error {
  constructor(
    readonly balance: number,
    readonly requested: number,
  ) {
    super(`Créditos insuficientes: saldo ${balance}, se necesitan ${-requested}`);
    this.name = "InsufficientCreditsError";
  }
}

export class LedgerConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerConflictError";
  }
}

/** Saldo actual del usuario (0 si no tiene movimientos). */
export async function getCreditBalance(db: DbExecutor, userId: string): Promise<number> {
  const [last] = await db
    .select({ balanceAfter: creditLedger.balanceAfter })
    .from(creditLedger)
    .where(eq(creditLedger.userId, userId))
    .orderBy(desc(creditLedger.seq))
    .limit(1);
  return last?.balanceAfter ?? 0;
}

/**
 * Única forma de cambiar el saldo de un usuario.
 *
 * - Bloquea la fila del usuario mientras calcula, así dos cobros simultáneos no pueden
 *   gastar el mismo saldo.
 * - Rechaza consumos que dejarían el saldo en negativo.
 * - Es idempotente: con la misma `idempotencyKey` devuelve el movimiento existente.
 */
export async function recordLedgerEntry(
  db: Database,
  input: LedgerEntryInput,
): Promise<{ entry: LedgerEntry; created: boolean }> {
  if (!Number.isInteger(input.amount) || input.amount === 0) {
    throw new RangeError("amount debe ser un entero distinto de 0");
  }
  if (!input.idempotencyKey.trim()) throw new RangeError("idempotencyKey es obligatoria");

  return db.transaction(async (tx) => {
    const [owner] = await tx.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).for("update");
    if (!owner) throw new LedgerConflictError("El usuario no existe");

    const [existing] = await tx
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.idempotencyKey, input.idempotencyKey))
      .limit(1);
    if (existing) {
      if (existing.userId !== input.userId || existing.amount !== input.amount || existing.type !== input.type) {
        throw new LedgerConflictError("La idempotencyKey ya se usó para otro movimiento");
      }
      return { entry: existing, created: false };
    }

    const balance = await getCreditBalance(tx, input.userId);
    const balanceAfter = balance + input.amount;
    if (balanceAfter < 0) throw new InsufficientCreditsError(balance, input.amount);

    const [entry] = await tx
      .insert(creditLedger)
      .values({
        userId: input.userId,
        amount: input.amount,
        balanceAfter,
        type: input.type,
        idempotencyKey: input.idempotencyKey,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        note: input.note,
      })
      .returning();
    return { entry: entry!, created: true };
  });
}
