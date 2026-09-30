import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { eq } from "drizzle-orm";
import { schema, type DbHandle } from "@clipflow/shared/db";
import { createTestDb } from "@clipflow/shared/db/testing";
import { handleMessage, runConsumer, type ConsumerOptions } from "./consumer.js";
import { makeDeps, makeSampleVideo, seedVideoJob } from "./test-helpers.js";

let h: DbHandle | undefined;
let root: string;
let sample: string;
beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "clipflow-consumer-"));
  sample = path.join(root, "sample.mp4");
  makeSampleVideo(sample);
});
beforeEach(async () => {
  await h?.close();
  h = await createTestDb();
});
afterAll(async () => {
  await h?.close();
  rmSync(root, { recursive: true, force: true });
});

/** SQS falso: registra qué se hizo con cada mensaje. */
function fakeSqs() {
  const calls: { command: string; input: Record<string, unknown> }[] = [];
  const client = {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      calls.push({ command: command.constructor.name, input: command.input });
      return {};
    },
  } as unknown as SQSClient;
  return { client, calls };
}

function options(sqs: SQSClient, overrides: Partial<ConsumerOptions["deps"]> = {}): ConsumerOptions {
  return {
    sqs,
    queueUrl: "https://sqs.test/q",
    visibilitySeconds: 300,
    shouldStop: () => true,
    deps: { ...makeDeps(h!.db, root, path.join(root, "work")), ...overrides },
  };
}
const message = (body: string) => ({ MessageId: "m1", ReceiptHandle: "r1", Body: body });

describe("consumidor de la cola", () => {
  it("procesa el trabajo, lo marca completado y borra el mensaje", async () => {
    const { job } = await seedVideoJob(h!.db, root, { sample });
    const sqs = fakeSqs();
    await handleMessage(message(JSON.stringify({ jobId: job.id })), options(sqs.client));
    const [row] = await h!.db.select().from(schema.processingJobs).where(eq(schema.processingJobs.id, job.id));
    expect(row).toMatchObject({ status: "completed", progress: 100, result: { ai: "disabled" } });
    expect((row!.result as { clipCount: number }).clipCount).toBeGreaterThan(0);
    expect(sqs.calls.map((c) => c.command)).toContain("DeleteMessageCommand");
  });

  it("un mensaje repetido de un trabajo ya completado se descarta sin procesar otra vez", async () => {
    const { job } = await seedVideoJob(h!.db, root, { sample });
    await handleMessage(message(JSON.stringify({ jobId: job.id })), options(fakeSqs().client));
    const clipsBefore = await h!.db.select().from(schema.clips).where(eq(schema.clips.jobId, job.id));

    const sqs = fakeSqs();
    await handleMessage(message(JSON.stringify({ jobId: job.id })), options(sqs.client));
    expect(sqs.calls.map((c) => c.command)).toEqual(["DeleteMessageCommand"]);
    const clipsAfter = await h!.db.select().from(schema.clips).where(eq(schema.clips.jobId, job.id));
    expect(clipsAfter.map((c) => c.id)).toEqual(clipsBefore.map((c) => c.id));
  });

  it("un aviso de encendido se mantiene oculto (worker despierto) y se borra al vencer", async () => {
    const fresh = fakeSqs();
    await handleMessage(
      { MessageId: "w1", ReceiptHandle: "rw", Body: JSON.stringify({ warmup: true }), Attributes: { SentTimestamp: String(Date.now() - 60_000) } },
      options(fresh.client),
    );
    expect(fresh.calls).toHaveLength(1);
    expect(fresh.calls[0]!.command).toBe("ChangeMessageVisibilityCommand");
    expect(fresh.calls[0]!.input.VisibilityTimeout).toBeGreaterThan(13 * 60);

    const old = fakeSqs();
    await handleMessage(
      { MessageId: "w2", ReceiptHandle: "rw", Body: JSON.stringify({ warmup: true }), Attributes: { SentTimestamp: String(Date.now() - 20 * 60_000) } },
      options(old.client),
    );
    expect(old.calls.map((c) => c.command)).toEqual(["DeleteMessageCommand"]);
  });

  it("un worker encendido por la API se apaga solo cuando no hay trabajos", async () => {
    const sqs = fakeSqs();
    const started = Date.now();
    await runConsumer({ ...options(sqs.client), shouldStop: () => false, idleExitSeconds: 0.2 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(sqs.calls.some((c) => c.command === "ReceiveMessageCommand")).toBe(true);
  });

  it("descarta mensajes mal formados", async () => {
    const sqs = fakeSqs();
    await handleMessage(message("no es json"), options(sqs.client));
    expect(sqs.calls.map((c) => c.command)).toEqual(["DeleteMessageCommand"]);
  });

  it("un error temporal devuelve el trabajo a la cola con espera", async () => {
    const { job } = await seedVideoJob(h!.db, root, { sample });
    const sqs = fakeSqs();
    const broken = {
      download: async () => {
        throw new Error("S3 no responde");
      },
      upload: async () => undefined,
    };
    await handleMessage(message(JSON.stringify({ jobId: job.id })), options(sqs.client, { storage: broken }));
    const [row] = await h!.db.select().from(schema.processingJobs).where(eq(schema.processingJobs.id, job.id));
    expect(row).toMatchObject({ status: "queued", attempts: 1, errorCode: "unexpected" });
    const visibility = sqs.calls.find((c) => c.command === "ChangeMessageVisibilityCommand" && c.input.VisibilityTimeout === 60);
    expect(visibility).toBeDefined();
    expect(sqs.calls.map((c) => c.command)).not.toContain("DeleteMessageCommand");
  });

  it("un archivo que no es video falla definitivamente y se borra el mensaje", async () => {
    const { job } = await seedVideoJob(h!.db, root, { sample, fake: true });
    const sqs = fakeSqs();
    await handleMessage(message(JSON.stringify({ jobId: job.id })), options(sqs.client));
    const [row] = await h!.db.select().from(schema.processingJobs).where(eq(schema.processingJobs.id, job.id));
    expect(row).toMatchObject({ status: "failed", errorCode: "invalid_video" });
    expect(row!.errorMessage).toMatch(/no es un video válido/);
    expect(sqs.calls.map((c) => c.command)).toContain("DeleteMessageCommand");
  });
});
