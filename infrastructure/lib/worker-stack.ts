import path from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as appscaling from "aws-cdk-lib/aws-applicationautoscaling";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sqs from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import { DATABASE_NAME } from "./database-stack.js";
import { resourcePrefix, type Stage } from "./stage.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface WorkerStackProps extends StackProps {
  stage: Stage;
  vpc: ec2.IVpc;
  bucket: s3.IBucket;
  database: rds.DatabaseInstance;
  databaseSecurityGroup: ec2.ISecurityGroup;
}

/**
 * Procesamiento asíncrono de video:
 *   API → SQS (cola de trabajos) → worker Fargate con FFmpeg → S3 / RDS
 * El worker ESCALA A CERO: sin trabajos no hay contenedores encendidos (0 USD).
 * Mensajes que fallan 6 veces van a la cola de errores (DLQ) y activan una alarma.
 */
export class WorkerStack extends Stack {
  readonly queue: sqs.Queue;

  constructor(scope: Construct, id: string, props: WorkerStackProps) {
    super(scope, id, props);
    const prefix = resourcePrefix(props.stage);

    const deadLetterQueue = new sqs.Queue(this, "JobsDlq", {
      queueName: `${prefix}-jobs-dlq`,
      retentionPeriod: Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });
    this.queue = new sqs.Queue(this, "JobsQueue", {
      queueName: `${prefix}-jobs`,
      visibilityTimeout: Duration.minutes(5), // el worker la renueva mientras procesa
      retentionPeriod: Duration.days(4),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      deadLetterQueue: { queue: deadLetterQueue, maxReceiveCount: 6 },
    });

    new cloudwatch.Alarm(this, "DlqAlarm", {
      alarmName: `${prefix}-jobs-dlq-not-empty`,
      alarmDescription: "Hay trabajos de video que fallaron repetidamente (revisar logs del worker).",
      metric: deadLetterQueue.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Clave de OpenAI: se crea con un valor aleatorio de relleno y el usuario pega la real
    // en la consola de Secrets Manager. Solo el worker puede leerla; nunca está en el código.
    const openAiKey = new secretsmanager.Secret(this, "OpenAiApiKey", {
      secretName: `${prefix}/openai-api-key`,
      description: "Clave de OpenAI para ClipFlow. Reemplaza el valor por tu clave (sk-...).",
      generateSecretString: { passwordLength: 32, excludePunctuation: true },
      removalPolicy: props.stage === "production" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    const cluster = new ecs.Cluster(this, "WorkerCluster", { clusterName: `${prefix}-workers`, vpc: props.vpc });
    const logGroup = new logs.LogGroup(this, "WorkerLogs", {
      logGroupName: `/clipflow/${props.stage}/worker`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, "WorkerTask", {
      cpu: 2048,
      memoryLimitMiB: 4096,
      ephemeralStorageGiB: 50, // espacio para el video original y los clips
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    const dbSecret = props.database.secret!;
    taskDefinition.addContainer("worker", {
      image: ecs.ContainerImage.fromAsset(REPO_ROOT, { file: "worker/Dockerfile", platform: Platform.LINUX_AMD64 }),
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "worker" }),
      stopTimeout: Duration.seconds(120),
      environment: {
        APP_ENV: props.stage === "production" ? "production" : "staging",
        LOG_LEVEL: "info",
        SQS_QUEUE_URL: this.queue.queueUrl,
        S3_BUCKET: props.bucket.bucketName,
        DB_HOST: props.database.dbInstanceEndpointAddress,
        DB_PORT: props.database.dbInstanceEndpointPort,
        DB_NAME: DATABASE_NAME,
        DATABASE_SSL: "true",
        SQS_VISIBILITY_SECONDS: "300",
        AI_PROVIDER: "openai",
        OPENAI_TRANSCRIBE_MODEL: "whisper-1",
        OPENAI_ANALYSIS_MODEL: "gpt-4o-mini",
        OPENAI_MAX_AUDIO_MINUTES: "180",
      },
      secrets: {
        // ECS lee el secreto al arrancar cada worker (como el worker escala a 0,
        // una clave nueva se usa desde el siguiente video).
        OPENAI_API_KEY: ecs.Secret.fromSecretsManager(openAiKey),
        DB_USER: ecs.Secret.fromSecretsManager(dbSecret, "username"),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, "password"),
      },
    });

    // Permisos mínimos: leer originales, escribir resultados, consumir la cola.
    this.queue.grantConsumeMessages(taskDefinition.taskRole);
    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({ actions: ["s3:GetObject"], resources: [props.bucket.arnForObjects("originals/*")] }),
    );
    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject"],
        resources: ["clips/*", "thumbnails/*", "subtitles/*", "tmp/*"].map((p) => props.bucket.arnForObjects(p)),
      }),
    );

    const workerSecurityGroup = new ec2.SecurityGroup(this, "WorkerSecurityGroup", {
      vpc: props.vpc,
      description: "Worker de video - no acepta conexiones entrantes",
    });
    new ec2.CfnSecurityGroupIngress(this, "DbFromWorker", {
      groupId: props.databaseSecurityGroup.securityGroupId,
      sourceSecurityGroupId: workerSecurityGroup.securityGroupId,
      ipProtocol: "tcp",
      fromPort: 5432,
      toPort: 5432,
      description: "PostgreSQL desde el worker",
    });

    const service = new ecs.FargateService(this, "WorkerService", {
      serviceName: `${prefix}-worker`,
      cluster,
      taskDefinition,
      desiredCount: 0,
      minHealthyPercent: 0,
      maxHealthyPercent: 200,
      assignPublicIp: true, // solo para salir a internet (S3/SQS/OpenAI); no entra nada
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [workerSecurityGroup],
      circuitBreaker: { rollback: true },
    });

    // Escalado según trabajos pendientes + en proceso (así no se apaga un worker trabajando).
    const backlog = new cloudwatch.MathExpression({
      expression: "visible + inflight",
      label: "Trabajos pendientes y en proceso",
      period: Duration.minutes(1),
      usingMetrics: {
        visible: this.queue.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1), statistic: "Maximum" }),
        inflight: this.queue.metricApproximateNumberOfMessagesNotVisible({ period: Duration.minutes(1), statistic: "Maximum" }),
      },
    });
    service
      .autoScaleTaskCount({ minCapacity: 0, maxCapacity: 3 })
      .scaleOnMetric("QueueBacklog", {
        metric: backlog,
        adjustmentType: appscaling.AdjustmentType.EXACT_CAPACITY,
        scalingSteps: [
          { upper: 0, change: 0 },
          { lower: 1, change: 1 },
          { lower: 4, change: 2 },
          { lower: 8, change: 3 },
        ],
        cooldown: Duration.minutes(1),
        evaluationPeriods: 1,
      });

    new CfnOutput(this, "QueueUrl", { value: this.queue.queueUrl });
    new CfnOutput(this, "OpenAiSecretName", { value: openAiKey.secretName });
  }
}
