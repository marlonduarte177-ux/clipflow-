import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { JobQueueMessage, WarmupQueueMessage } from "@clipflow/shared";

/** Cola de trabajos. El mensaje solo lleva el id; el worker lee el resto de la base. */
export interface JobQueue {
  send(jobId: string): Promise<void>;
  /** Pide encender el procesador (se llama al empezar una subida). */
  warmUp(): Promise<void>;
}

/** Como mucho un aviso de encendido por minuto y por servidor: basta para mantenerlo despierto. */
const WARMUP_EVERY_MS = 60_000;

export function createSqsQueue(options: { queueUrl: string; region: string; client?: SQSClient }): JobQueue {
  const sqs = options.client ?? new SQSClient({ region: options.region });
  let lastWarmup = 0;
  return {
    async warmUp() {
      if (Date.now() - lastWarmup < WARMUP_EVERY_MS) return;
      lastWarmup = Date.now();
      const body: WarmupQueueMessage = { warmup: true };
      await sqs.send(new SendMessageCommand({ QueueUrl: options.queueUrl, MessageBody: JSON.stringify(body) }));
    },
    async send(jobId) {
      const body: JobQueueMessage = { jobId };
      await sqs.send(new SendMessageCommand({ QueueUrl: options.queueUrl, MessageBody: JSON.stringify(body) }));
    },
  };
}
