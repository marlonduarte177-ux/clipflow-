import { beforeAll, describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { ApiStack } from "../lib/api-stack.js";
import { AuthStack } from "../lib/auth-stack.js";
import { DatabaseStack } from "../lib/database-stack.js";
import { MonitoringStack } from "../lib/monitoring-stack.js";
import { NetworkStack } from "../lib/network-stack.js";
import { StorageStack } from "../lib/storage-stack.js";
import { WorkerStack } from "../lib/worker-stack.js";

const WEB = ["https://web.example.com"];
let t: Record<"network" | "storage" | "database" | "worker" | "api" | "monitoring" | "monitoringQuiet", Template>;

beforeAll(() => {
  const app = new App();
  const env = { account: "123456789012", region: "us-east-1" };
  // Evita consultas a AWS durante los tests.
  app.node.setContext("availability-zones:account=123456789012:region=us-east-1", ["us-east-1a", "us-east-1b"]);
  const stage = "staging" as const;
  const auth = new AuthStack(app, "auth", { env, stage });
  const network = new NetworkStack(app, "network", { env, stage });
  const storage = new StorageStack(app, "storage", { env, stage, webOrigins: WEB });
  const database = new DatabaseStack(app, "database", { env, stage, vpc: network.vpc });
  const worker = new WorkerStack(app, "worker", {
    env,
    stage,
    vpc: network.vpc,
    bucket: storage.bucket,
    database: database.instance,
    databaseSecurityGroup: database.securityGroup,
  });
  const api = new ApiStack(app, "api", {
    env,
    stage,
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
    webOrigins: WEB,
  });
  const monitoring = new MonitoringStack(app, "monitoring", {
    env,
    stage,
    deadLetterQueue: worker.deadLetterQueue,
    workerLogs: worker.logGroup,
    httpApi: api.httpApi,
    database: database.instance,
    alertEmail: "alertas@example.com",
    monthlyBudgetUsd: 50,
  });
  const monitoringQuiet = new MonitoringStack(app, "monitoring-quiet", {
    env,
    stage,
    deadLetterQueue: worker.deadLetterQueue,
    workerLogs: worker.logGroup,
    httpApi: api.httpApi,
    database: database.instance,
  });
  t = {
    monitoring: Template.fromStack(monitoring),
    monitoringQuiet: Template.fromStack(monitoringQuiet),
    network: Template.fromStack(network),
    storage: Template.fromStack(storage),
    database: Template.fromStack(database),
    worker: Template.fromStack(worker),
    api: Template.fromStack(api),
  };
}, 120_000);

describe("red", () => {
  it("no crea NAT Gateway (costo) y tiene endpoint privado a S3", () => {
    t.network.resourceCountIs("AWS::EC2::NatGateway", 0);
    t.network.hasResourceProperties("AWS::EC2::VPCEndpoint", { VpcEndpointType: "Gateway" });
  });
});

describe("S3", () => {
  it("es privado, cifrado y exige HTTPS", () => {
    t.storage.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: Match.objectLike({}),
    });
    t.storage.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Effect: "Deny", Condition: { Bool: { "aws:SecureTransport": "false" } } }),
        ]),
      },
    });
  });

  it("solo acepta subidas desde la web y expone el ETag", () => {
    t.storage.hasResourceProperties("AWS::S3::Bucket", {
      CorsConfiguration: {
        CorsRules: [Match.objectLike({ AllowedOrigins: WEB, ExposedHeaders: ["ETag"] })],
      },
    });
  });

  it("limpia subidas abandonadas y archivos temporales", () => {
    t.storage.hasResourceProperties("AWS::S3::Bucket", {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({ AbortIncompleteMultipartUpload: { DaysAfterInitiation: 2 } }),
          Match.objectLike({ Prefix: "tmp/", ExpirationInDays: 1 }),
        ]),
      },
    });
  });
});

describe("base de datos", () => {
  it("no es pública, está cifrada y tiene backups", () => {
    t.database.hasResourceProperties("AWS::RDS::DBInstance", {
      PubliclyAccessible: false,
      StorageEncrypted: true,
      BackupRetentionPeriod: 7,
      DBInstanceClass: "db.t4g.micro",
      Engine: "postgres",
    });
  });

  it("la contraseña la genera Secrets Manager", () => {
    t.database.resourceCountIs("AWS::SecretsManager::Secret", 1);
  });
});

describe("API", () => {
  it("todas las rutas excepto /health y el aviso de Paddle exigen token de Cognito", () => {
    t.api.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "GET /{proxy+}",
      AuthorizationType: "JWT",
    });
    t.api.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "POST /{proxy+}",
      AuthorizationType: "JWT",
    });
    t.api.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "GET /health",
      AuthorizationType: "NONE",
    });
    // Los avisos de Paddle no traen sesión: la API comprueba su firma.
    t.api.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "POST /billing/paddle-webhook",
      AuthorizationType: "NONE",
    });
  });

  it("pagos: la clave de los avisos de Paddle vive en Secrets Manager y los pagos empiezan apagados", () => {
    t.api.hasResourceProperties("AWS::SecretsManager::Secret", {
      Name: "clipflow-staging/paddle-webhook-secret",
      GenerateSecretString: { PasswordLength: 32, RequireEachIncludedType: true },
    });
    const [taskDef] = Object.values(t.api.findResources("AWS::ECS::TaskDefinition"));
    const container = (taskDef as { Properties: { ContainerDefinitions: Record<string, unknown>[] } }).Properties.ContainerDefinitions[0]!;
    expect((container.Secrets as { Name: string }[]).map((e) => e.Name)).toContain("PADDLE_WEBHOOK_SECRET");
    const env = Object.fromEntries((container.Environment as { Name: string; Value: string }[]).map((e) => [e.Name, e.Value]));
    expect(env).toMatchObject({ BILLING_ENABLED: "false", PADDLE_ENVIRONMENT: "sandbox" });
  });

  it("tiene límite de tráfico y CORS solo para la web", () => {
    t.api.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      DefaultRouteSettings: { ThrottlingRateLimit: 20, ThrottlingBurstLimit: 50 },
    });
    t.api.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      CorsConfiguration: Match.objectLike({ AllowOrigins: WEB }),
    });
  });

  it("la contraseña de la BD llega como secreto, nunca como texto", () => {
    const [taskDef] = Object.values(t.api.findResources("AWS::ECS::TaskDefinition"));
    const container = (taskDef as { Properties: { ContainerDefinitions: Record<string, unknown>[] } }).Properties
      .ContainerDefinitions[0]!;
    const envNames = (container.Environment as { Name: string }[]).map((e) => e.Name);
    const secretNames = (container.Secrets as { Name: string }[]).map((s) => s.Name);
    expect(envNames).not.toContain("DB_PASSWORD");
    expect(secretNames).toEqual(expect.arrayContaining(["DB_USER", "DB_PASSWORD"]));
  });

  it("el contenedor solo acepta tráfico del VPC Link", () => {
    const groups = t.api.findResources("AWS::EC2::SecurityGroup", {
      Properties: { GroupDescription: Match.stringLikeRegexp("solo acepta trafico del VPC Link") },
    });
    const [apiSg] = Object.values(groups) as { Properties: { SecurityGroupIngress?: { CidrIp?: string }[] } }[];
    for (const rule of apiSg!.Properties.SecurityGroupIngress ?? []) expect(rule.CidrIp).toBeUndefined();
  });

  it("solo puede escribir en originals/ y solo leer resultados; puede encolar trabajos", () => {
    const statements = s3Statements(t.api);
    const writes = statements.filter((s) => [s.Action].flat().includes("s3:PutObject"));
    expect(writes).toHaveLength(1);
    expect(JSON.stringify(writes[0]!.Resource)).toContain("/originals/*");
    // Ningún permiso sobre el bucket completo: siempre una carpeta concreta.
    for (const s of statements) {
      if ([s.Action].flat().includes("s3:ListBucket")) {
        // Listar (para eliminar videos) solo dentro de las carpetas de la app.
        expect(s.Action).toBe("s3:ListBucket");
        expect(JSON.stringify(s.Condition)).toContain('"s3:prefix":["originals/*","clips/*","thumbnails/*","subtitles/*","exports/*","transcripts/*"]');
      } else {
        expect(JSON.stringify(s.Resource)).toMatch(/\/(originals|clips|thumbnails|subtitles|exports|transcripts)\/\*/);
      }
    }
    t.api.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Action: Match.arrayWith(["sqs:SendMessage"]) })]) },
    });
  });
});

type Statement = { Action: string | string[]; Resource: unknown; Condition?: unknown };
function s3Statements(template: Template): Statement[] {
  return Object.values(template.findResources("AWS::IAM::Policy"))
    .flatMap((p) => (p as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties.PolicyDocument.Statement)
    .filter((s) => [s.Action].flat().some((a) => a.startsWith("s3:")));
}

describe("encendido directo del worker desde la API", () => {
  it("la API solo puede lanzar la tarea del worker en su cluster y pasarle sus roles", () => {
    const statements = Object.values(t.api.findResources("AWS::IAM::Policy")).flatMap(
      (p) => (p as { Properties: { PolicyDocument: { Statement: Record<string, unknown>[] } } }).Properties.PolicyDocument.Statement,
    );
    const run = statements.find((st) => st.Action === "ecs:RunTask")!;
    expect(JSON.stringify(run.Resource)).toContain("task-definition/clipflow-staging-worker:*");
    expect(run.Condition).toHaveProperty("ArnEquals");
    const pass = statements.find((st) => st.Action === "iam:PassRole")!;
    expect(pass.Condition).toEqual({ StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } });
    expect(statements.some((st) => st.Action === "ecs:*" || st.Action === "*")).toBe(false);
  });
});

describe("cola y worker", () => {
  it("la cola tiene cola de errores (DLQ) con alarma", () => {
    t.worker.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "clipflow-staging-jobs",
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 6 }),
      SqsManagedSseEnabled: true,
    });
    // Su alarma (con aviso por correo) está en el stack de monitoreo.
    t.monitoring.hasResourceProperties("AWS::CloudWatch::Alarm", { AlarmName: "clipflow-staging-alert-jobs-failed" });
  });

  it("el worker empieza en 0, se enciende con 1 pendiente y se apaga tras 10 min sin trabajo", () => {
    t.worker.hasResourceProperties("AWS::ECS::Service", { DesiredCount: 0 });
    t.worker.hasResourceProperties("AWS::ApplicationAutoScaling::ScalableTarget", { MinCapacity: 0, MaxCapacity: 3 });
    t.worker.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "clipflow-staging-worker-backlog",
      Threshold: 1,
      EvaluationPeriods: 1,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
    });
    t.worker.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "clipflow-staging-worker-idle",
      Threshold: 0,
      EvaluationPeriods: 10,
      ComparisonOperator: "LessThanOrEqualToThreshold",
    });
    // Solo dos políticas: encender (rápida) y apagar (lenta). Ninguna apaga al instante.
    t.worker.resourceCountIs("AWS::ApplicationAutoScaling::ScalingPolicy", 2);
    t.worker.hasResourceProperties("AWS::ApplicationAutoScaling::ScalingPolicy", {
      StepScalingPolicyConfiguration: Match.objectLike({
        AdjustmentType: "ExactCapacity",
        StepAdjustments: [Match.objectLike({ ScalingAdjustment: 0, MetricIntervalUpperBound: 0 })],
      }),
    });
  });

  it("tiene CPU, memoria y disco para videos largos", () => {
    t.worker.hasResourceProperties("AWS::ECS::TaskDefinition", {
      Cpu: "4096",
      Memory: "8192",
      EphemeralStorage: { SizeInGiB: 50 },
    });
  });

  it("no acepta conexiones entrantes", () => {
    const groups = t.worker.findResources("AWS::EC2::SecurityGroup");
    for (const g of Object.values(groups) as { Properties: { SecurityGroupIngress?: unknown[] } }[]) {
      expect(g.Properties.SecurityGroupIngress ?? []).toEqual([]);
    }
  });

  it("el proxy de descarga vive en Secrets Manager, llega solo al worker y nunca como texto", () => {
    t.worker.hasResourceProperties("AWS::SecretsManager::Secret", { Name: "clipflow-staging/download-proxy" });
    const [taskDef] = Object.values(t.worker.findResources("AWS::ECS::TaskDefinition"));
    const container = (taskDef as { Properties: { ContainerDefinitions: Record<string, unknown>[] } }).Properties
      .ContainerDefinitions[0]!;
    expect((container.Environment as { Name: string }[]).map((e) => e.Name)).not.toContain("DOWNLOAD_PROXY_URL");
    expect((container.Secrets as { Name: string }[]).map((e) => e.Name)).toContain("DOWNLOAD_PROXY_URL");
    expect(JSON.stringify(t.api.toJSON())).not.toContain("download-proxy");
  });

  it("la clave de OpenAI vive en Secrets Manager y llega al worker como secreto", () => {
    t.worker.hasResourceProperties("AWS::SecretsManager::Secret", { Name: "clipflow-staging/openai-api-key" });
    const [taskDef] = Object.values(t.worker.findResources("AWS::ECS::TaskDefinition"));
    const container = (taskDef as { Properties: { ContainerDefinitions: Record<string, unknown>[] } }).Properties
      .ContainerDefinitions[0]!;
    expect((container.Environment as { Name: string }[]).map((e) => e.Name)).not.toContain("OPENAI_API_KEY");
    expect((container.Secrets as { Name: string }[]).map((e) => e.Name)).toContain("OPENAI_API_KEY");
    const env = container.Environment as { Name: string; Value: string }[];
    expect(env.find((e) => e.Name === "AI_VISION_ENABLED")?.Value).toBe("false"); // apagado: caro en videos largos
    expect(env.find((e) => e.Name === "FACE_TRACKING_ENABLED")?.Value).toBe("true");
    // La API no tiene acceso a la clave.
    expect(JSON.stringify(t.api.toJSON())).not.toContain("openai-api-key");
  });

  it("sin AssemblyAI: la transcripción la hace Whisper con la clave de OpenAI", () => {
    expect(JSON.stringify(t.worker.toJSON())).not.toContain("assemblyai");
  });

  it("lee originales, escribe resultados y solo puede AGREGAR originales (videos por enlace), nunca borrarlos", () => {
    const statements = s3Statements(t.worker);
    const reads = statements.filter((s) => [s.Action].flat().includes("s3:GetObject"));
    const writes = statements.filter((s) => [s.Action].flat().includes("s3:PutObject"));
    expect(JSON.stringify(reads.map((s) => s.Resource))).toContain("/originals/*");
    expect(JSON.stringify(writes.map((s) => s.Resource))).toContain("/clips/*");
    const originals = writes.filter((s) => JSON.stringify(s.Resource).includes("/originals/*"));
    expect(originals).toHaveLength(1);
    expect([originals[0]!.Action].flat().sort()).toEqual(["s3:AbortMultipartUpload", "s3:PutObject"]);
    expect(statements.every((s) => ![s.Action].flat().includes("s3:DeleteObject"))).toBe(true);
  });
});

describe("alertas", () => {
  it("avisa por correo de trabajos fallidos, OpenAI o el proxy sin saldo, errores de la API y la base de datos", () => {
    const m = t.monitoring;
    m.hasResourceProperties("AWS::SNS::Subscription", { Protocol: "email", Endpoint: "alertas@example.com" });
    for (const name of ["jobs-failed", "openai-account", "download-proxy", "api-5xx", "db-storage", "db-cpu"]) {
      m.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: `clipflow-staging-alert-${name}`,
        AlarmActions: [Match.objectLike({ Ref: Match.anyValue() })],
      });
    }
    m.hasResourceProperties("AWS::Logs::MetricFilter", { FilterPattern: '?"insufficient_quota" ?"invalid_api_key"' });
    m.hasResourceProperties("AWS::Budgets::Budget", {
      Budget: Match.objectLike({ BudgetLimit: { Amount: 50, Unit: "USD" }, TimeUnit: "MONTHLY" }),
    });
  });

  it("sin correo configurado: alarmas sí, pero sin suscripción ni presupuesto", () => {
    t.monitoringQuiet.resourceCountIs("AWS::SNS::Subscription", 0);
    t.monitoringQuiet.resourceCountIs("AWS::Budgets::Budget", 0);
    t.monitoringQuiet.resourceCountIs("AWS::CloudWatch::Alarm", 6);
  });
});

describe("protección de datos (staging es hoy el entorno real)", () => {
  it("staging protege los datos en la configuración", async () => {
    const { STAGE_CONFIG } = await import("../lib/stage-config.js");
    expect(STAGE_CONFIG.staging.protectData).toBe(true);
  });

  it("con protectData: BD y usuarios con protección de borrado, bucket conservado, sin multi-AZ (no duplica el costo)", () => {
    const app = new App();
    const env = { account: "123456789012", region: "us-east-1" };
    app.node.setContext("availability-zones:account=123456789012:region=us-east-1", ["us-east-1a", "us-east-1b"]);
    const stage = "staging" as const;
    const authStack = new AuthStack(app, "auth-p", { env, stage, protectData: true });
    const network = new NetworkStack(app, "network-p", { env, stage });
    const storageStack = new StorageStack(app, "storage-p", { env, stage, protectData: true, webOrigins: WEB });
    const databaseStack = new DatabaseStack(app, "database-p", { env, stage, protectData: true, vpc: network.vpc });
    const auth = Template.fromStack(authStack);
    const storage = Template.fromStack(storageStack);
    const database = Template.fromStack(databaseStack);

    auth.hasResourceProperties("AWS::Cognito::UserPool", { DeletionProtection: "ACTIVE" });
    auth.hasResource("AWS::Cognito::UserPool", { DeletionPolicy: "Retain" });
    storage.hasResource("AWS::S3::Bucket", { DeletionPolicy: "Retain" });
    expect(Object.keys(storage.findResources("Custom::S3AutoDeleteObjects"))).toHaveLength(0);
    database.hasResourceProperties("AWS::RDS::DBInstance", { DeletionProtection: true, MultiAZ: false });
  });
});
