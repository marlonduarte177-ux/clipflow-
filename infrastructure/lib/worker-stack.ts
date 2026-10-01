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
  readonly cluster: ecs.Cluster;
  readonly taskDefinition: ecs.FargateTaskDefinition;
  readonly securityGroup: ec2.SecurityGroup;
  readonly taskFamily: string;

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

    // Proxy residencial para importar de plataformas que bloquean a AWS (YouTube…). Se crea con un
    // valor de relleno (el proxy queda apagado) y el usuario pega su URL en Secrets Manager:
    // http://USUARIO:CONTRASEÑA@rp.evomi.com:1000. Solo el worker puede leerla.
    const downloadProxy = new secretsmanager.Secret(this, "DownloadProxy", {
      secretName: `${prefix}/download-proxy`,
      description: "Proxy residencial para descargar videos por enlace. Valor: http://USUARIO:CONTRASEÑA@host:puerto",
      generateSecretString: { passwordLength: 32, excludePunctuation: true },
      removalPolicy: props.stage === "production" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    const cluster = new ecs.Cluster(this, "WorkerCluster", { clusterName: `${prefix}-workers`, vpc: props.vpc });
    this.cluster = cluster;
    this.taskFamily = `${prefix}-worker`;
    const logGroup = new logs.LogGroup(this, "WorkerLogs", {
      logGroupName: `/clipflow/${props.stage}/worker`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, "WorkerTask", {
      family: this.taskFamily,
      cpu: 4096, // 4 vCPU: análisis, IA y 2 clips a la vez
      memoryLimitMiB: 8192,
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
        // Fargate x86 us-east-1: 4 vCPU × 0.04048 + 8 GB × 0.004445 ≈ 0.1975 USD/h.
        WORKER_COST_PER_HOUR_USD: "0.1975",
        AI_PROVIDER: "openai",
        OPENAI_TRANSCRIBE_MODEL: "whisper-1",
        OPENAI_ANALYSIS_MODEL: "gpt-4o-mini",
        OPENAI_MAX_AUDIO_MINUTES: "180",
        // Análisis de imágenes con IA: apagado (probado en staging: caro en videos largos y satura el
        // límite por minuto de OpenAI). El código sigue disponible: "true" lo vuelve a activar.
        AI_VISION_ENABLED: "false",
        AI_VISION_INTERVAL_SECONDS: "3",
        AI_VISION_MAX_FRAMES: "600",
        // Encuadre que sigue a quien habla (detector local YuNet, sin costo por imagen).
        FACE_TRACKING_ENABLED: "true",
        // Importar por enlace (YouTube, TikTok…): yt-dlp instalado en la imagen.
        YTDLP_PATH: "/usr/local/bin/yt-dlp",
      },
      secrets: {
        // ECS lee el secreto al arrancar cada worker (como el worker escala a 0,
        // una clave nueva se usa desde el siguiente video).
        OPENAI_API_KEY: ecs.Secret.fromSecretsManager(openAiKey),
        DOWNLOAD_PROXY_URL: ecs.Secret.fromSecretsManager(downloadProxy),
        DB_USER: ecs.Secret.fromSecretsManager(dbSecret, "username"),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, "password"),
      },
    });

    // Permisos mínimos: leer originales, escribir resultados, consumir la cola.
    this.queue.grantConsumeMessages(taskDefinition.taskRole);
    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({ actions: ["s3:GetObject"], resources: [props.bucket.arnForObjects("originals/*")] }),
    );
    // Videos importados por enlace: el worker los descarga y guarda el original (en partes si es
    // grande). No puede borrar originales.
    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject", "s3:AbortMultipartUpload"],
        resources: [props.bucket.arnForObjects("originals/*")],
      }),
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
    this.taskDefinition = taskDefinition;
    this.securityGroup = workerSecurityGroup;
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
    // Se reutiliza el ScalableTarget que ya existe en AWS (mismo ID lógico): ECS solo admite uno
    // por servicio, y crear otro nuevo falla con "already exists".
    service.autoScaleTaskCount({ minCapacity: 0, maxCapacity: 3 });
    const scalingTarget = service.node.findChild("TaskCount").node.findChild("Target") as appscaling.ScalableTarget;

    // Encender rápido: con 1 pendiente (un trabajo o el aviso que envía la API al empezar una
    // subida) se arranca en ~1 min. 1–3 pendientes → 1 worker; 4–7 → 2; 8+ → 3.
    const scaleOut = new appscaling.StepScalingAction(this, "ScaleOutAction", {
      scalingTarget,
      adjustmentType: appscaling.AdjustmentType.EXACT_CAPACITY,
      cooldown: Duration.minutes(1),
    });
    scaleOut.addAdjustment({ lowerBound: 0, upperBound: 3, adjustment: 1 });
    scaleOut.addAdjustment({ lowerBound: 3, upperBound: 7, adjustment: 2 });
    scaleOut.addAdjustment({ lowerBound: 7, adjustment: 3 });
    new cloudwatch.Alarm(this, "BacklogAlarm", {
      alarmName: `${prefix}-worker-backlog`,
      alarmDescription: "Hay trabajos de video pendientes: encender workers.",
      metric: backlog,
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction({ bind: () => ({ alarmActionArn: scaleOut.scalingPolicyArn }) });

    // Apagar sin prisa: solo tras 10 min seguidos sin nada que hacer, para que el siguiente video
    // empiece al instante (cuesta ~0.03 USD cada vez que queda encendido esperando).
    const scaleIn = new appscaling.StepScalingAction(this, "ScaleInAction", {
      scalingTarget,
      adjustmentType: appscaling.AdjustmentType.EXACT_CAPACITY,
      cooldown: Duration.minutes(5),
    });
    scaleIn.addAdjustment({ upperBound: 0, adjustment: 0 });
    new cloudwatch.Alarm(this, "IdleAlarm", {
      alarmName: `${prefix}-worker-idle`,
      alarmDescription: "El worker lleva 10 min sin trabajos: se apaga.",
      metric: backlog,
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 10,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    }).addAlarmAction({ bind: () => ({ alarmActionArn: scaleIn.scalingPolicyArn }) });

    new CfnOutput(this, "QueueUrl", { value: this.queue.queueUrl });
    new CfnOutput(this, "OpenAiSecretName", { value: openAiKey.secretName });
    new CfnOutput(this, "DownloadProxySecretName", { value: downloadProxy.secretName });
  }
}
