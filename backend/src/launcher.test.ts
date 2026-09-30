import { describe, expect, it } from "vitest";
import type { ECSClient } from "@aws-sdk/client-ecs";
import { createEcsLauncher } from "./launcher.js";

function fakeEcs(runningTasks: number) {
  const calls: { command: string; input: Record<string, unknown> }[] = [];
  const client = {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      calls.push({ command: command.constructor.name, input: command.input });
      if (command.constructor.name === "ListTasksCommand") {
        return { taskArns: Array.from({ length: runningTasks }, (_, i) => `arn:task/${i}`) };
      }
      return {};
    },
  } as unknown as ECSClient;
  return { client, calls };
}

const base = {
  clusterArn: "arn:aws:ecs:us-east-1:1:cluster/workers",
  taskFamily: "clipflow-staging-worker",
  subnets: ["subnet-a", "subnet-b"],
  securityGroups: ["sg-worker"],
  maxWorkers: 3,
  region: "us-east-1",
  minIntervalMs: 0,
};

describe("encendido directo de procesadores", () => {
  it("si no hay ninguno encendido, arranca uno que se apaga solo al quedar inactivo", async () => {
    const ecs = fakeEcs(0);
    const result = await createEcsLauncher({ ...base, client: ecs.client }).ensureRunning();
    expect(result).toEqual({ running: 0, started: 1 });
    const run = ecs.calls.find((c) => c.command === "RunTaskCommand")!.input as Record<string, any>;
    expect(run.taskDefinition).toBe("clipflow-staging-worker");
    expect(run.networkConfiguration.awsvpcConfiguration).toMatchObject({ subnets: ["subnet-a", "subnet-b"], assignPublicIp: "ENABLED" });
    expect(run.overrides.containerOverrides[0].environment).toEqual([{ name: "WORKER_IDLE_EXIT_SECONDS", value: "600" }]);
  });

  it("si ya hay uno encendido, no arranca otro", async () => {
    const ecs = fakeEcs(1);
    expect(await createEcsLauncher({ ...base, client: ecs.client }).ensureRunning()).toEqual({ running: 1, started: 0 });
    expect(ecs.calls.map((c) => c.command)).toEqual(["ListTasksCommand"]);
  });

  it("con muchos trabajos arranca más, sin pasar del máximo", async () => {
    const ecs = fakeEcs(1);
    expect(await createEcsLauncher({ ...base, client: ecs.client }).ensureRunning(10)).toEqual({ running: 1, started: 2 });
  });

  it("no consulta ECS en ráfaga", async () => {
    const ecs = fakeEcs(1);
    const launcher = createEcsLauncher({ ...base, client: ecs.client, minIntervalMs: 60_000 });
    await launcher.ensureRunning();
    await launcher.ensureRunning();
    await launcher.ensureRunning();
    expect(ecs.calls).toHaveLength(1);
  });
});
