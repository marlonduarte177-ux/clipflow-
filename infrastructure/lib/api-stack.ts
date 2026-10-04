import path from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpUserPoolAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpServiceDiscoveryIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import type * as sqs from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import { DATABASE_NAME } from "./database-stack.js";
import { resourcePrefix, type Stage } from "./stage.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const API_PORT = 4000;

export interface ApiStackProps extends StackProps {
  stage: Stage;
  vpc: ec2.IVpc;
  bucket: s3.IBucket;
  database: rds.DatabaseInstance;
  databaseSecurityGroup: ec2.ISecurityGroup;
  userPool: cognito.IUserPool;
  userPoolClient: cognito.IUserPoolClient;
  queue: sqs.IQueue;
  webOrigins: string[];
  /** Correos con acceso a la prueba lado a lado (variable ADMIN_EMAILS de GitHub; no está en el código). */
  adminEmails?: string;
  /** Procesador de video que la API enciende directamente al empezar una subida. */
  worker: {
    cluster: ecs.ICluster;
    taskDefinition: ecs.FargateTaskDefinition;
    taskFamily: string;
    securityGroup: ec2.ISecurityGroup;
  };
}

/**
 * API de ClipFlow:
 *   Navegador → API Gateway (HTTPS, valida el token de Cognito, limita tráfico)
 *             → VPC Link → contenedor Fargate (Node.js) → RDS / S3
 * El contenedor no acepta conexiones de internet: solo del VPC Link.
 */
export class ApiStack extends Stack {
  readonly apiUrl: string;
  readonly httpApi: apigw.HttpApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const prefix = resourcePrefix(props.stage);

    const cluster = new ecs.Cluster(this, "Cluster", {
      clusterName: `${prefix}-cluster`,
      vpc: props.vpc,
      defaultCloudMapNamespace: {
        name: `${prefix}.internal`,
        type: servicediscovery.NamespaceType.DNS_PRIVATE,
        vpc: props.vpc,
      },
    });

    const logGroup = new logs.LogGroup(this, "ApiLogs", {
      logGroupName: `/clipflow/${props.stage}/api`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, "ApiTask", {
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const dbSecret = props.database.secret!;
    taskDefinition.addContainer("api", {
      image: ecs.ContainerImage.fromAsset(REPO_ROOT, { file: "backend/Dockerfile", platform: Platform.LINUX_AMD64 }),
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "api" }),
      portMappings: [{ containerPort: API_PORT }],
      environment: {
        APP_ENV: props.stage === "production" ? "production" : "staging",
        API_PORT: String(API_PORT),
        LOG_LEVEL: "info",
        CORS_ALLOWED_ORIGINS: props.webOrigins.join(","),
        ADMIN_EMAILS: props.adminEmails ?? "",
        // Prueba lado a lado: pipeline actual contra Groq + cada modelo de Gemini.
        COMPARE_PIPELINES: "classic,gemini:gemini-3.5-flash,gemini:gemini-3.1-flash-lite",
        COGNITO_USER_POOL_ID: props.userPool.userPoolId,
        COGNITO_CLIENT_ID: props.userPoolClient.userPoolClientId,
        S3_BUCKET: props.bucket.bucketName,
        SQS_QUEUE_URL: props.queue.queueUrl,
        WORKER_CLUSTER_ARN: props.worker.cluster.clusterArn,
        WORKER_TASK_FAMILY: props.worker.taskFamily,
        WORKER_SUBNETS: props.vpc.selectSubnets({ subnetType: ec2.SubnetType.PUBLIC }).subnetIds.join(","),
        WORKER_SECURITY_GROUPS: props.worker.securityGroup.securityGroupId,
        WORKER_MAX_TASKS: "3",
        DB_HOST: props.database.dbInstanceEndpointAddress,
        DB_PORT: props.database.dbInstanceEndpointPort,
        DB_NAME: DATABASE_NAME,
        DATABASE_SSL: "true",
        RUN_MIGRATIONS_ON_START: "true",
      },
      // Usuario y contraseña de la BD: los inyecta ECS desde Secrets Manager.
      secrets: {
        DB_USER: ecs.Secret.fromSecretsManager(dbSecret, "username"),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, "password"),
      },
      healthCheck: {
        command: [
          "CMD",
          "node",
          "-e",
          `fetch('http://127.0.0.1:${API_PORT}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`,
        ],
        interval: Duration.seconds(30),
        startPeriod: Duration.seconds(60),
      },
    });

    // Permisos mínimos en S3: solo la carpeta de originales, solo lo necesario para subir.
    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          "s3:PutObject",
          "s3:GetObject",
          "s3:DeleteObject",
          "s3:AbortMultipartUpload",
          "s3:ListMultipartUploadParts",
        ],
        resources: [props.bucket.arnForObjects("originals/*")],
      }),
    );
    // Previews y descargas: lectura de resultados. Borrado: solo cuando el usuario elimina un video.
    const results = ["clips/*", "thumbnails/*", "subtitles/*", "exports/*", "transcripts/*"];
    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:DeleteObject"],
        resources: results.map((p) => props.bucket.arnForObjects(p)),
      }),
    );
    // Listar archivos para borrarlos, solo dentro de esas mismas carpetas.
    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["s3:ListBucket"],
        resources: [props.bucket.bucketArn],
        conditions: { StringLike: { "s3:prefix": ["originals/*", ...results] } },
      }),
    );
    props.queue.grantSendMessages(taskDefinition.taskRole);

    // Encender el procesador de video al instante: solo ESTA definición de tarea, en ESTE cluster.
    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["ecs:RunTask"],
        resources: [`arn:${this.partition}:ecs:${this.region}:${this.account}:task-definition/${props.worker.taskFamily}:*`],
        conditions: { ArnEquals: { "ecs:cluster": props.worker.cluster.clusterArn } },
      }),
    );
    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["ecs:ListTasks"],
        resources: ["*"],
        conditions: { ArnEquals: { "ecs:cluster": props.worker.cluster.clusterArn } },
      }),
    );
    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [props.worker.taskDefinition.taskRole.roleArn, props.worker.taskDefinition.obtainExecutionRole().roleArn],
        conditions: { StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } },
      }),
    );

    const vpcLinkSecurityGroup = new ec2.SecurityGroup(this, "VpcLinkSecurityGroup", {
      vpc: props.vpc,
      description: "VPC Link de API Gateway hacia la API",
    });
    const apiSecurityGroup = new ec2.SecurityGroup(this, "ApiSecurityGroup", {
      vpc: props.vpc,
      description: "API de ClipFlow - solo acepta trafico del VPC Link",
    });
    apiSecurityGroup.addIngressRule(vpcLinkSecurityGroup, ec2.Port.tcp(API_PORT), "API Gateway");

    // La base de datos acepta conexiones solo desde la API.
    new ec2.CfnSecurityGroupIngress(this, "DbFromApi", {
      groupId: props.databaseSecurityGroup.securityGroupId,
      sourceSecurityGroupId: apiSecurityGroup.securityGroupId,
      ipProtocol: "tcp",
      fromPort: 5432,
      toPort: 5432,
      description: "PostgreSQL desde la API",
    });

    const service = new ecs.FargateService(this, "ApiService", {
      serviceName: `${prefix}-api`,
      cluster,
      taskDefinition,
      desiredCount: 1,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      assignPublicIp: true, // para salir a internet sin NAT (Cognito, SQS); no permite entrar
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [apiSecurityGroup],
      circuitBreaker: { rollback: true },
      cloudMapOptions: {
        name: "api",
        dnsRecordType: servicediscovery.DnsRecordType.SRV,
        containerPort: API_PORT,
      },
    });

    const vpcLink = new apigw.VpcLink(this, "VpcLink", {
      vpc: props.vpc,
      subnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [vpcLinkSecurityGroup],
    });

    const httpApi = new apigw.HttpApi(this, "HttpApi", {
      apiName: `${prefix}-api`,
      corsPreflight: {
        allowOrigins: props.webOrigins,
        allowMethods: [
          apigw.CorsHttpMethod.GET,
          apigw.CorsHttpMethod.POST,
          apigw.CorsHttpMethod.PATCH,
          apigw.CorsHttpMethod.DELETE,
        ],
        allowHeaders: ["Authorization", "Content-Type"],
        maxAge: Duration.minutes(10),
      },
    });

    const integration = new HttpServiceDiscoveryIntegration("Api", service.cloudMapService!, { vpcLink });
    const authorizer = new HttpUserPoolAuthorizer("Cognito", props.userPool, {
      userPoolClients: [props.userPoolClient],
    });

    httpApi.addRoutes({ path: "/health", methods: [apigw.HttpMethod.GET], integration });
    httpApi.addRoutes({
      path: "/{proxy+}",
      methods: [apigw.HttpMethod.GET, apigw.HttpMethod.POST, apigw.HttpMethod.PATCH, apigw.HttpMethod.DELETE],
      integration,
      authorizer,
    });

    // Límite de tráfico para toda la API (protege contra abusos y costos inesperados).
    const stage = httpApi.defaultStage!.node.defaultChild as apigw.CfnStage;
    stage.defaultRouteSettings = { throttlingRateLimit: 20, throttlingBurstLimit: 50 };

    this.apiUrl = httpApi.apiEndpoint;
    this.httpApi = httpApi;
    new CfnOutput(this, "ApiUrl", { value: httpApi.apiEndpoint });
  }
}
