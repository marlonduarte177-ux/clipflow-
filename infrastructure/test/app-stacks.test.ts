import { beforeAll, describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { ApiStack } from "../lib/api-stack.js";
import { AuthStack } from "../lib/auth-stack.js";
import { DatabaseStack } from "../lib/database-stack.js";
import { NetworkStack } from "../lib/network-stack.js";
import { StorageStack } from "../lib/storage-stack.js";
import { WorkerStack } from "../lib/worker-stack.js";

const WEB = ["https://web.example.com"];
let t: Record<"network" | "storage" | "database" | "worker" | "api", Template>;

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
  t = {
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
  it("todas las rutas excepto /health exigen token de Cognito", () => {
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
        expect(JSON.stringify(s.Condition)).toContain('"s3:prefix":["originals/*","clips/*","thumbnails/*","subtitles/*","exports/*"]');
      } else {
        expect(JSON.stringify(s.Resource)).toMatch(/\/(originals|clips|thumbnails|subtitles|exports)\/\*/);
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
    t.worker.hasResourceProperties("AWS::CloudWatch::Alarm", { AlarmName: "clipflow-staging-jobs-dlq-not-empty" });
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

  it("la clave de OpenAI vive en Secrets Manager y llega al worker como secreto", () => {
    t.worker.hasResourceProperties("AWS::SecretsManager::Secret", { Name: "clipflow-staging/openai-api-key" });
    const [taskDef] = Object.values(t.worker.findResources("AWS::ECS::TaskDefinition"));
    const container = (taskDef as { Properties: { ContainerDefinitions: Record<string, unknown>[] } }).Properties
      .ContainerDefinitions[0]!;
    expect((container.Environment as { Name: string }[]).map((e) => e.Name)).not.toContain("OPENAI_API_KEY");
    expect((container.Secrets as { Name: string }[]).map((e) => e.Name)).toContain("OPENAI_API_KEY");
    const env = container.Environment as { Name: string; Value: string }[];
    expect(env.find((e) => e.Name === "AI_VISION_ENABLED")?.Value).toBe("true"); // staging: activado para medir
    // La API no tiene acceso a la clave.
    expect(JSON.stringify(t.api.toJSON())).not.toContain("openai-api-key");
  });

  it("lee solo originales y escribe solo resultados", () => {
    const statements = s3Statements(t.worker);
    const reads = statements.filter((s) => [s.Action].flat().includes("s3:GetObject"));
    const writes = statements.filter((s) => [s.Action].flat().includes("s3:PutObject"));
    expect(JSON.stringify(reads.map((s) => s.Resource))).toContain("/originals/*");
    expect(JSON.stringify(writes.map((s) => s.Resource))).not.toContain("originals");
    expect(JSON.stringify(writes.map((s) => s.Resource))).toContain("/clips/*");
  });
});
