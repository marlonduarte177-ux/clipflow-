import { ECSClient, ListTasksCommand, RunTaskCommand } from "@aws-sdk/client-ecs";

/**
 * Enciende procesadores de video al instante (sin esperar las métricas de la cola, que pueden
 * tardar varios minutos). Los procesadores que arranca la API se apagan solos tras un rato sin trabajo.
 */
export interface WorkerLauncher {
  /** Se asegura de que haya al menos `wanted` procesadores encendidos (hasta el máximo). */
  ensureRunning(wanted?: number): Promise<{ running: number; started: number }>;
}

export interface EcsLauncherOptions {
  clusterArn: string;
  /** Familia de la definición de tarea del worker (usa la última revisión activa). */
  taskFamily: string;
  subnets: string[];
  securityGroups: string[];
  maxWorkers: number;
  region: string;
  client?: ECSClient;
  /** No volver a consultar ECS antes de este tiempo (evita llamadas en ráfaga). */
  minIntervalMs?: number;
}

export function createEcsLauncher(options: EcsLauncherOptions): WorkerLauncher {
  const ecs = options.client ?? new ECSClient({ region: options.region });
  const minInterval = options.minIntervalMs ?? 15_000;
  let last = 0;
  let lastWanted = 0;
  return {
    async ensureRunning(wanted = 1) {
      const target = Math.min(Math.max(1, wanted), options.maxWorkers);
      if (Date.now() - last < minInterval && target <= lastWanted) return { running: -1, started: 0 };
      last = Date.now();
      lastWanted = target;
      // Incluye los que están arrancando (su estado deseado ya es RUNNING).
      const list = await ecs.send(
        new ListTasksCommand({ cluster: options.clusterArn, family: options.taskFamily, desiredStatus: "RUNNING" }),
      );
      const running = list.taskArns?.length ?? 0;
      const toStart = Math.max(0, target - running);
      if (toStart === 0) return { running, started: 0 };
      await ecs.send(
        new RunTaskCommand({
          cluster: options.clusterArn,
          taskDefinition: options.taskFamily,
          launchType: "FARGATE",
          count: toStart,
          startedBy: "clipflow-api",
          networkConfiguration: {
            awsvpcConfiguration: {
              subnets: options.subnets,
              securityGroups: options.securityGroups,
              assignPublicIp: "ENABLED",
            },
          },
          overrides: {
            // Estos procesadores se apagan solos tras 10 min sin trabajo.
            containerOverrides: [{ name: "worker", environment: [{ name: "WORKER_IDLE_EXIT_SECONDS", value: "600" }] }],
          },
        }),
      );
      return { running, started: toStart };
    },
  };
}

/** Sin ECS configurado (desarrollo local): no hace nada. */
export const noopLauncher: WorkerLauncher = {
  async ensureRunning() {
    return { running: 0, started: 0 };
  },
};
