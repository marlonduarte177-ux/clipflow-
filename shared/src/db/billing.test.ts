import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "./client.js";
import { createTestDb } from "./testing.js";
import { upsertUser } from "./users.js";
import { getCreditBalance, InsufficientCreditsError } from "./ledger.js";
import { chargeVideoMinutes, refundVideoMinutes, setPlanMinutes } from "./billing.js";

let h: DbHandle | undefined;
beforeEach(async () => {
  await h?.close();
  h = await createTestDb();
});
afterAll(async () => {
  await h?.close();
});

const video = "11111111-1111-4111-8111-111111111111";

describe("minutos del plan", () => {
  it("la carga deja el saldo exacto del plan (no se acumula) y un aviso repetido no carga dos veces", async () => {
    const db = h!.db;
    const user = await upsertUser(db, { cognitoSub: "s1", email: "a@example.com" });
    expect(await setPlanMinutes(db, { userId: user.id, minutes: 60, eventId: "paddle:txn_1", note: "prueba" })).toBe(true);
    expect(await getCreditBalance(db, user.id)).toBe(60);
    await chargeVideoMinutes(db, { userId: user.id, videoId: video, run: "j1@1", minutes: 20 });
    // El mismo aviso otra vez: no vuelve a llenar el saldo.
    expect(await setPlanMinutes(db, { userId: user.id, minutes: 60, eventId: "paddle:txn_1", note: "prueba" })).toBe(false);
    expect(await getCreditBalance(db, user.id)).toBe(40);
    // Renovación: 600 exactos (lo que sobraba no se suma).
    await setPlanMinutes(db, { userId: user.id, minutes: 600, eventId: "paddle:txn_2", note: "pro" });
    expect(await getCreditBalance(db, user.id)).toBe(600);
    // Cancelado: queda en 0.
    await setPlanMinutes(db, { userId: user.id, minutes: 0, eventId: "paddle:sub_1:ended", note: "fin" });
    expect(await getCreditBalance(db, user.id)).toBe(0);
  });

  it("un video se cobra una vez; si falla se devuelve y al reintentarlo se cobra de nuevo", async () => {
    const db = h!.db;
    const user = await upsertUser(db, { cognitoSub: "s2", email: "b@example.com" });
    await setPlanMinutes(db, { userId: user.id, minutes: 60, eventId: "e1", note: "prueba" });

    expect(await chargeVideoMinutes(db, { userId: user.id, videoId: video, run: "j1@1", minutes: 10 })).toEqual({ charged: 10, balance: 50 });
    // Volver a analizar el mismo video: no cobra.
    expect(await chargeVideoMinutes(db, { userId: user.id, videoId: video, run: "j1@1", minutes: 10 })).toEqual({ charged: 0, balance: 50 });

    expect(await refundVideoMinutes(db, { userId: user.id, videoId: video, run: "j1@1" })).toBe(10);
    expect(await refundVideoMinutes(db, { userId: user.id, videoId: video, run: "j1@1" })).toBe(0);
    expect(await getCreditBalance(db, user.id)).toBe(60);

    expect((await chargeVideoMinutes(db, { userId: user.id, videoId: video, run: "j1@2", minutes: 10 })).charged).toBe(10);
    expect(await getCreditBalance(db, user.id)).toBe(50);
    // Vuelve a analizarlo (otra vuelta, no cobra) y falla: no se devuelve lo pagado por la vuelta anterior.
    expect((await chargeVideoMinutes(db, { userId: user.id, videoId: video, run: "j1@3", minutes: 10 })).charged).toBe(0);
    expect(await refundVideoMinutes(db, { userId: user.id, videoId: video, run: "j1@3" })).toBe(0);
    expect(await getCreditBalance(db, user.id)).toBe(50);
  });

  it("sin minutos suficientes no descuenta nada", async () => {
    const db = h!.db;
    const user = await upsertUser(db, { cognitoSub: "s3", email: "c@example.com" });
    await setPlanMinutes(db, { userId: user.id, minutes: 5, eventId: "e1", note: "x" });
    const err = await chargeVideoMinutes(db, { userId: user.id, videoId: video, run: "j@1", minutes: 6 }).catch((e) => e);
    expect(err).toBeInstanceOf(InsufficientCreditsError);
    expect(await getCreditBalance(db, user.id)).toBe(5);
  });
});
