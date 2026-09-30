import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { JobQueueMessage } from "@clipflow/shared";

/** Cola de trabajos. El mensaje solo lleva el id; el worker lee el resto de la base. */
export interface JobQueue {
  send(jobId: string): Promise<void>;
}

export function createSqsQueue(options: { queueUrl: string; region: string; client?: SQSClient }): JobQueue {
  const sqs = options.client ?? new SQSClient({ region: options.region });
  return {
    async send(jobId) {
      const body: JobQueueMessage = { jobId };
      await sqs.send(new SendMessageCommand({ QueueUrl: options.queueUrl, MessageBody: JSON.stringify(body) }));
    },
  };
}
