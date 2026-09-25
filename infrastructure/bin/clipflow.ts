import { App, Tags } from "aws-cdk-lib";
import { AuthStack } from "../lib/auth-stack.js";
import { parseStage, resourcePrefix } from "../lib/stage.js";

const app = new App();
const stage = parseStage(app.node.tryGetContext("stage"));

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
};

new AuthStack(app, `${resourcePrefix(stage)}-auth`, { env, stage });

// Etiquetas en todos los recursos: permiten ver costos por entorno en Billing.
Tags.of(app).add("project", "clipflow");
Tags.of(app).add("stage", stage);
