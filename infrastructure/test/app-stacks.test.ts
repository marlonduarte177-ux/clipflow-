import { beforeAll, describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { ApiStack } from "../lib/api-stack.js";
import { AuthStack } from "../lib/auth-stack.js";
import { DatabaseStack } from "../lib/database-stack.js";
import { NetworkStack } from "../lib/network-stack.js";
import { StorageStack } from "../lib/storage-stack.js";

const WEB = ["https://web.example.com"];
let t: Record<"network" | "storage" | "database" | "api", Template>;

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
  const api = new ApiStack(app, "api", {
    env,
    stage,
    vpc: network.vpc,
    bucket: storage.bucket,
    database: database.instance,
    databaseSecurityGroup: database.securityGroup,
    userPool: auth.userPool,
    userPoolClient: auth.userPoolClient,
    webOrigins: WEB,
  });
  t = {
    network: Template.fromStack(network),
    storage: Template.fromStack(storage),
    database: Template.fromStack(database),
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

  it("los permisos de S3 se limitan a la carpeta originals/", () => {
    const policies = t.api.findResources("AWS::IAM::Policy");
    const s3Statements = Object.values(policies).flatMap(
      (p) =>
        (p as { Properties: { PolicyDocument: { Statement: { Action: string | string[]; Resource: unknown }[] } } })
          .Properties.PolicyDocument.Statement,
    ).filter((s) => [s.Action].flat().some((a) => a.startsWith("s3:")));
    expect(s3Statements).toHaveLength(1);
    expect(JSON.stringify(s3Statements[0]!.Resource)).toContain("/originals/*");
    expect([s3Statements[0]!.Action].flat()).not.toContain("s3:*");
  });
});
