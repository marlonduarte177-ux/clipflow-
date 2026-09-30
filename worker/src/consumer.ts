import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from "@aws-sdk/client-sqs";
import { eq } from "drizzle-orm";
import type { JobQueueMessage } from "@clipflow/shared";
import { claimJob, completeJob, failJob, markJobCancelled, schema } from "@clipflow/shared/db";
import { JobError, JobStopped, processAnalyzeJob, type PipelineDeps } from "./pipeline.js";

export interface ConsumerOptions {
  sqs: SQSClient;
  queueUrl: string;
  visibilitySeconds: number;
  deps: PipelineDeps;
  shouldStop: () => boolean;
}

/**
 * Bucle del worker: toma un mensaje, reclama el trabajo en la base (solo uno puede),
 * lo procesa renovando la visibilidad del mensaje y al final lo borra de la cola.
 */
export async function runConsumer(options: ConsumerOptions): Promise<void> {
  let consecutiveErrors = 0;
  while (!options.shouldStop()) {
    try {
      const res = await options.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: options.queueUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 20,
          VisibilityTimeout: options.visibilitySeconds,
        }),
      );
      for (const message of res.Messages ?? []) await handleMessage(message, options);
      consecutiveErrors = 0;
    } catch (err) {
      // Error de red o de AWS: se registra y se reintenta con espera creciente (máx. 60 s).
      consecutiveErrors++;
      options.deps.log.warn({ error: (err as Error).name, consecutiveErrors }, "error leyendo la cola");
      if (consecutiveErrors >= 20) throw err; // algo está mal de verdad: ECS reinicia el contenedor
      await new Promise((r) => setTimeout(r, Math.min(60_000, 1000 * 2 ** consecutiveErrors)));
    }
  }
}

export async function handleMessage(message: Message, options: ConsumerOptions): Promise<void> {
  const { deps, sqs, queueUrl } = options;
  const remove = () => sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
  const delay = (seconds: number) =>
    sqs.send(
      new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: seconds }),
    );

  let jobId: string;
  try {
    jobId = (JSON.parse(message.Body ?? "") as JobQueueMessage).jobId;
    if (typeof jobId !== "string") throw new Error();
  } catch {
    deps.log.warn({ messageId: message.MessageId }, "mensaje inválido descartado");
    await remove();
    return;
  }

  const job = await claimJob(deps.db, jobId, deps.workerId);
  if (!job) {
    // Ya terminado, cancelado, agotado o lo tiene otro worker activo.
    const [existing] = await deps.db.select().from(schema.processingJobs).where(eq(schema.processingJobs.id, jobId));
    if (existing?.status === "processing") await delay(options.visibilitySeconds);
    else await remove();
    return;
  }
  deps.log.info({ jobId, attempt: job.attempts }, "trabajo iniciado");

  // Mientras se procesa, el mensaje sigue oculto a otros workers.
  const keepHidden = setInterval(
    () => void delay(options.visibilitySeconds).catch(() => undefined),
    (options.visibilitySeconds * 1000) / 3,
  );
  try {
    const result = await processAnalyzeJob(job, deps);
    await completeJob(deps.db, job.id, deps.workerId, { ...result });
    deps.log.info({ jobId, clipCount: result.clipCount, ai: result.ai }, "trabajo completado");
    await remove();
  } catch (err) {
    if (err instanceof JobStopped) {
      if (err.reason === "cancel") await markJobCancelled(deps.db, job.id, deps.workerId);
      deps.log.info({ jobId, reason: err.reason }, "trabajo detenido");
      await remove();
      return;
    }
    const jobError =
      err instanceof JobError ? err : new JobError("unexpected", "Ocurrió un error temporal al procesar el video.", true);
    const result = await failJob(deps.db, job.id, deps.workerId, {
      code: jobError.code,
      message: jobError.userMessage,
      retryable: jobError.retryable,
    });
    deps.log.warn({ jobId, code: jobError.code, result }, "trabajo con error");
    // Reintento: el mismo mensaje reaparece tras una espera creciente.
    if (result === "requeued") await delay(Math.min(900, 60 * job.attempts));
    else await remove();
  } finally {
    clearInterval(keepHidden);
  }
}
