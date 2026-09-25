import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { DbHandle } from "./client.js";
import { createTestDb } from "./testing.js";
import { clips, creditLedger, exports, processingJobs, projects, subtitles, videos } from "./schema.js";
import { upsertUser } from "./users.js";
import {
  getCreditBalance,
  InsufficientCreditsError,
  LedgerConflictError,
  recordLedgerEntry,
} from "./ledger.js";

let h: DbHandle | undefined;
// Cada test empieza con una base vacía (el ledger no admite TRUNCATE: se recrea el esquema).
beforeEach(async () => {
  await h?.close();
  h = await createTestDb();
});
afterAll(async () => {
  await h?.close();
});

/** Código de error de PostgreSQL (drizzle lo envuelve en `cause`). */
async function pgErrorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code;
  }
}

async function makeUserWithVideo(sub: string) {
  const user = await upsertUser(h!.db, { cognitoSub: sub, email: `${sub}@example.com` });
  const [project] = await h!.db.insert(projects).values({ userId: user.id, name: "Proyecto" }).returning();
  const [video] = await h!.db
    .insert(videos)
    .values({
      userId: user.id,
      projectId: project!.id,
      originalFilename: "video.mp4",
      mimeType: "video/mp4",
      sizeBytes: 1000,
      s3Key: `originals/${user.id}/${sub}/original.mp4`,
    })
    .returning();
  return { user, project: project!, video: video! };
}

describe("migraciones", () => {
  it("crean todas las tablas requeridas", async () => {
    const result = await h!.db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );
    expect(result.rows.map((r) => r.table_name)).toEqual([
      "clips",
      "credit_ledger",
      "exports",
      "processing_jobs",
      "projects",
      "subscriptions",
      "subtitles",
      "usage",
      "users",
      "videos",
    ]);
  });
});

describe("usuarios", () => {
  it("upsertUser no duplica al mismo usuario de Cognito y conserva el email", async () => {
    const a = await upsertUser(h!.db, { cognitoSub: "sub-1", email: "a@example.com" });
    const b = await upsertUser(h!.db, { cognitoSub: "sub-1" });
    expect(b.id).toBe(a.id);
    expect(b.email).toBe("a@example.com");
  });
});

describe("aislamiento entre usuarios en la base de datos", () => {
  it("no permite guardar un video de A dentro de un proyecto de B", async () => {
    const a = await makeUserWithVideo("user-a");
    const b = await makeUserWithVideo("user-b");
    const code = await pgErrorCode(
      h!.db.insert(videos).values({
        userId: a.user.id,
        projectId: b.project.id,
        originalFilename: "x.mp4",
        mimeType: "video/mp4",
        sizeBytes: 1,
        s3Key: "originals/x",
      }),
    );
    expect(code).toBe("23503"); // foreign_key_violation
  });

  it("no permite crear un trabajo o un clip de A sobre un video de B", async () => {
    const a = await makeUserWithVideo("user-a");
    const b = await makeUserWithVideo("user-b");
    expect(
      await pgErrorCode(
        h!.db.insert(processingJobs).values({
          userId: a.user.id,
          videoId: b.video.id,
          type: "analyze_video",
          idempotencyKey: "k1",
        }),
      ),
    ).toBe("23503");
    expect(
      await pgErrorCode(
        h!.db.insert(clips).values({ userId: a.user.id, videoId: b.video.id, startSeconds: 0, endSeconds: 10 }),
      ),
    ).toBe("23503");
  });

  it("no permite exportar ni subtitular el clip de otro usuario", async () => {
    const a = await makeUserWithVideo("user-a");
    const b = await makeUserWithVideo("user-b");
    const [clipB] = await h!.db
      .insert(clips)
      .values({ userId: b.user.id, videoId: b.video.id, startSeconds: 0, endSeconds: 10 })
      .returning();
    expect(await pgErrorCode(h!.db.insert(exports).values({ userId: a.user.id, clipId: clipB!.id }))).toBe("23503");
    expect(
      await pgErrorCode(
        h!.db
          .insert(subtitles)
          .values({ userId: a.user.id, videoId: a.video.id, clipId: clipB!.id, format: "srt", s3Key: "s" }),
      ),
    ).toBe("23503");
  });
});

describe("reglas de datos", () => {
  it("rechaza clips con fin antes del inicio o score fuera de 0–1", async () => {
    const { user, video } = await makeUserWithVideo("u");
    const base = { userId: user.id, videoId: video.id };
    expect(await pgErrorCode(h!.db.insert(clips).values({ ...base, startSeconds: 10, endSeconds: 5 }))).toBe("23514");
    expect(
      await pgErrorCode(h!.db.insert(clips).values({ ...base, startSeconds: 0, endSeconds: 5, score: 1.5 })),
    ).toBe("23514");
  });

  it("rechaza progreso fuera de 0–100 y claves de idempotencia repetidas en trabajos", async () => {
    const { user, video } = await makeUserWithVideo("u");
    const job = { userId: user.id, videoId: video.id, type: "analyze_video" as const };
    expect(
      await pgErrorCode(h!.db.insert(processingJobs).values({ ...job, idempotencyKey: "a", progress: 101 })),
    ).toBe("23514");
    await h!.db.insert(processingJobs).values({ ...job, idempotencyKey: "same" });
    expect(await pgErrorCode(h!.db.insert(processingJobs).values({ ...job, idempotencyKey: "same" }))).toBe("23505");
  });

  it("borrar un proyecto borra sus videos, trabajos y clips", async () => {
    const { user, project, video } = await makeUserWithVideo("u");
    await h!.db.insert(processingJobs).values({ userId: user.id, videoId: video.id, type: "analyze_video", idempotencyKey: "k" });
    await h!.db.insert(clips).values({ userId: user.id, videoId: video.id, startSeconds: 0, endSeconds: 5 });
    await h!.db.delete(projects).where(sql`${projects.id} = ${project.id}`);
    const counts = await h!.db.execute<{ v: number; j: number; c: number }>(
      sql`select (select count(*) from videos)::int v, (select count(*) from processing_jobs)::int j, (select count(*) from clips)::int c`,
    );
    expect(counts.rows[0]).toEqual({ v: 0, j: 0, c: 0 });
  });
});

describe("libro de créditos (credit_ledger)", () => {
  it("calcula el saldo con los movimientos", async () => {
    const { user } = await makeUserWithVideo("u");
    expect(await getCreditBalance(h!.db, user.id)).toBe(0);
    await recordLedgerEntry(h!.db, { userId: user.id, amount: 100, type: "bonus", idempotencyKey: "bonus-1" });
    const { entry } = await recordLedgerEntry(h!.db, {
      userId: user.id,
      amount: -30,
      type: "processing",
      idempotencyKey: "job-1",
      referenceType: "processing_job",
      referenceId: "job-1",
    });
    expect(entry.balanceAfter).toBe(70);
    expect(await getCreditBalance(h!.db, user.id)).toBe(70);
  });

  it("no permite gastar más créditos de los que hay", async () => {
    const { user } = await makeUserWithVideo("u");
    await recordLedgerEntry(h!.db, { userId: user.id, amount: 10, type: "bonus", idempotencyKey: "b" });
    await expect(
      recordLedgerEntry(h!.db, { userId: user.id, amount: -11, type: "processing", idempotencyKey: "p" }),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(await getCreditBalance(h!.db, user.id)).toBe(10);
  });

  it("es idempotente: el mismo movimiento no se cobra dos veces", async () => {
    const { user } = await makeUserWithVideo("u");
    await recordLedgerEntry(h!.db, { userId: user.id, amount: 50, type: "bonus", idempotencyKey: "b" });
    const first = await recordLedgerEntry(h!.db, { userId: user.id, amount: -20, type: "processing", idempotencyKey: "job" });
    const again = await recordLedgerEntry(h!.db, { userId: user.id, amount: -20, type: "processing", idempotencyKey: "job" });
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.entry.id).toBe(first.entry.id);
    expect(await getCreditBalance(h!.db, user.id)).toBe(30);
  });

  it("rechaza reutilizar una clave para otro movimiento u otro usuario", async () => {
    const a = await makeUserWithVideo("a");
    const b = await makeUserWithVideo("b");
    await recordLedgerEntry(h!.db, { userId: a.user.id, amount: 5, type: "bonus", idempotencyKey: "k" });
    await expect(
      recordLedgerEntry(h!.db, { userId: b.user.id, amount: 5, type: "bonus", idempotencyKey: "k" }),
    ).rejects.toBeInstanceOf(LedgerConflictError);
  });

  it("cobros simultáneos no pueden gastar el mismo saldo", async () => {
    const { user } = await makeUserWithVideo("u");
    await recordLedgerEntry(h!.db, { userId: user.id, amount: 100, type: "bonus", idempotencyKey: "b" });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        recordLedgerEntry(h!.db, { userId: user.id, amount: -30, type: "processing", idempotencyKey: `job-${i}` }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(await getCreditBalance(h!.db, user.id)).toBe(10);
  });

  it("los movimientos no se pueden modificar ni borrar (ni siquiera con SQL directo)", async () => {
    const { user } = await makeUserWithVideo("u");
    await recordLedgerEntry(h!.db, { userId: user.id, amount: 10, type: "bonus", idempotencyKey: "b" });
    expect(await pgErrorCode(h!.db.update(creditLedger).set({ amount: 999999, balanceAfter: 999999 }))).toBe("23001");
    expect(await pgErrorCode(h!.db.delete(creditLedger))).toBe("23001");
    expect(await pgErrorCode(h!.db.execute(sql`truncate credit_ledger`))).toBe("23001");
    expect(await getCreditBalance(h!.db, user.id)).toBe(10);
  });

  it("rechaza montos inválidos", async () => {
    const { user } = await makeUserWithVideo("u");
    await expect(recordLedgerEntry(h!.db, { userId: user.id, amount: 0, type: "bonus", idempotencyKey: "z" })).rejects.toThrow(RangeError);
    await expect(recordLedgerEntry(h!.db, { userId: user.id, amount: 1.5, type: "bonus", idempotencyKey: "z" })).rejects.toThrow(RangeError);
  });
});
