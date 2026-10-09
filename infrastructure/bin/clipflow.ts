import { App, Tags } from "aws-cdk-lib";
import { ApiStack } from "../lib/api-stack.js";
import { AuthStack } from "../lib/auth-stack.js";
import { DatabaseStack } from "../lib/database-stack.js";
import { MonitoringStack } from "../lib/monitoring-stack.js";
import { NetworkStack } from "../lib/network-stack.js";
import { parseStage, resourcePrefix } from "../lib/stage.js";
import { stageConfig } from "../lib/stage-config.js";
import { StorageStack } from "../lib/storage-stack.js";
import { WorkerStack } from "../lib/worker-stack.js";

const app = new App();
const stage = parseStage(app.node.tryGetContext("stage"));
const config = stageConfig(stage);
const prefix = resourcePrefix(stage);

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
};

// Pagos con Paddle: valores PÚBLICOS desde variables del environment de GitHub (ver
// docs/pagos-paddle.md). La clave secreta de los avisos está en Secrets Manager, no aquí.
const ctx = (name: string): string | undefined => {
  const v = app.node.tryGetContext(name);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};
const billing = {
  enabled: ctx("billingEnabled") === "true",
  freeEmails: ctx("billingFreeEmails"),
  paddleEnvironment: ctx("paddleEnvironment") === "production" ? ("production" as const) : ("sandbox" as const),
  paddleClientToken: ctx("paddleClientToken"),
  paddlePriceTrialFee: ctx("paddlePriceTrialFee"),
  paddlePriceBasic: ctx("paddlePriceBasic"),
  paddlePricePro: ctx("paddlePricePro"),
  paddlePriceMax: ctx("paddlePriceMax"),
  paddlePortalUrl: ctx("paddlePortalUrl"),
};

const auth = new AuthStack(app, `${prefix}-auth`, { env, stage, protectData: config.protectData });
const network = new NetworkStack(app, `${prefix}-network`, { env, stage });
const storage = new StorageStack(app, `${prefix}-storage`, { env, stage, protectData: config.protectData, webOrigins: config.webOrigins });
const database = new DatabaseStack(app, `${prefix}-database`, { env, stage, protectData: config.protectData, vpc: network.vpc });
const worker = new WorkerStack(app, `${prefix}-worker`, {
  env,
  stage,
  protectData: config.protectData,
  vpc: network.vpc,
  bucket: storage.bucket,
  database: database.instance,
  databaseSecurityGroup: database.securityGroup,
  billing: { enabled: billing.enabled, freeEmails: billing.freeEmails },
});
const api = new ApiStack(app, `${prefix}-api`, {
  env,
  stage,
  protectData: config.protectData,
  vpc: network.vpc,
  bucket: storage.bucket,
  database: database.instance,
  databaseSecurityGroup: database.securityGroup,
  userPool: auth.userPool,
  userPoolClient: auth.userPoolClient,
  queue: worker.queue,
  worker: {
    cluster: worker.cluster,
    taskDefinition: worker.taskDefinition,
    taskFamily: worker.taskFamily,
    securityGroup: worker.securityGroup,
  },
  webOrigins: config.webOrigins,
  billing,
});

// Alertas por correo y presupuesto. El correo y el presupuesto llegan desde variables de GitHub
// (ALERT_EMAIL, MONTHLY_BUDGET_USD): no están en el código.
const budget = Number(app.node.tryGetContext("monthlyBudgetUsd"));
new MonitoringStack(app, `${prefix}-monitoring`, {
  env,
  stage,
  deadLetterQueue: worker.deadLetterQueue,
  workerLogs: worker.logGroup,
  httpApi: api.httpApi,
  database: database.instance,
  alertEmail: app.node.tryGetContext("alertEmail") || undefined,
  monthlyBudgetUsd: Number.isFinite(budget) && budget > 0 ? budget : undefined,
});

// Etiquetas en todos los recursos: permiten ver costos por entorno en Billing.
Tags.of(app).add("project", "clipflow");
Tags.of(app).add("stage", stage);
