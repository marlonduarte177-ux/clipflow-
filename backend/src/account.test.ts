import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { recordLedgerEntry, schema } from "@clipflow/shared/db";
import { bearer, closeTestApp, createTestApp, type TestContext } from "./test-helpers.js";

let ctx: TestContext | undefined;
beforeEach(async () => {
  ctx = await createTestApp();
});
afterEach(async () => {
  await closeTestApp(ctx);
  ctx = undefined;
});
const app = () => ctx!.app;
const db = () => ctx!.database.db;

async function videoOf(sub: string) {
  const project = (await app().inject({ method: "POST", url: "/projects", headers: bearer(sub), payload: { name: "P" } })).json().id;
  const { video } = (
    await app().inject({
      method: "POST",
      url: "/videos",
      headers: bearer(sub),
      payload: { projectId: project, filename: "a.mp4", sizeBytes: 1024, mimeType: "video/mp4" },
    })
  ).json();
  const userId = (await app().inject({ method: "GET", url: "/me", headers: bearer(sub) })).json().userId as string;
  const keys = [`originals/${userId}/${video.id}/a.mp4`, `transcripts/${userId}/${video.id}/x.json`, `transcripts/${userId}/suelto/y.json`];
  keys.forEach((k) => ctx!.storage.objects.set(k, 1));
  return { userId, video, keys };
}

describe("cuenta", () => {
  it("GET /me incluye los créditos disponibles en minutos", async () => {
    const me = (await app().inject({ method: "GET", url: "/me", headers: bearer("alice") })).json();
    expect(me.creditMinutes).toBe(0);
    await recordLedgerEntry(db(), { userId: me.userId, amount: 30, type: "bonus", idempotencyKey: "regalo-1" });
    expect((await app().inject({ method: "GET", url: "/me", headers: bearer("alice") })).json().creditMinutes).toBe(30);
  });

  it("DELETE /me borra todos los videos y archivos del usuario y desactiva la cuenta", async () => {
    const alice = await videoOf("alice");
    const bob = await videoOf("bob");
    const res = await app().inject({ method: "DELETE", url: "/me", headers: bearer("alice") });
    expect(res.statusCode).toBe(204);

    const keys = [...ctx!.storage.objects.keys()];
    expect(keys.filter((k) => k.includes(alice.userId))).toEqual([]);
    expect(keys.filter((k) => k.includes(bob.userId))).toHaveLength(3);
    expect(await db().select().from(schema.videos).where(eq(schema.videos.userId, alice.userId))).toEqual([]);
    expect(await db().select().from(schema.projects).where(eq(schema.projects.userId, alice.userId))).toEqual([]);
    const [row] = await db().select().from(schema.users).where(eq(schema.users.id, alice.userId));
    expect(row).toMatchObject({ email: null, cognitoSub: `deleted:${alice.userId}` });
    expect(row!.deletedAt).not.toBeNull();

    // Si vuelve a entrar con el mismo login (antes de borrarse de Cognito), empieza de cero.
    const again = (await app().inject({ method: "GET", url: "/me", headers: bearer("alice") })).json();
    expect(again.userId).not.toBe(alice.userId);
    expect((await app().inject({ method: "GET", url: "/videos", headers: bearer("bob") })).statusCode).toBe(200);
  });

  it("DELETE /me con un video procesándose responde 409", async () => {
    const alice = await videoOf("alice");
    await db().insert(schema.processingJobs).values({
      userId: alice.userId,
      videoId: alice.video.id,
      type: "analyze_video",
      status: "processing",
      idempotencyKey: "k1",
      heartbeatAt: sql`now()`,
    });
    const res = await app().inject({ method: "DELETE", url: "/me", headers: bearer("alice") });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("video_processing");
    const [row] = await db().select().from(schema.users).where(eq(schema.users.id, alice.userId));
    expect(row!.deletedAt).toBeNull();
  });
});
