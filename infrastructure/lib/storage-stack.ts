import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import { resourcePrefix, type Stage } from "./stage.js";

export interface StorageStackProps extends StackProps {
  /** Proteger los datos contra borrado (también fuera de "production": hoy staging es el entorno real). */
  protectData?: boolean;
  stage: Stage;
  webOrigins: string[];
}

/**
 * Bucket privado para todos los archivos de ClipFlow, separado por prefijos:
 * originals/ tmp/ clips/ thumbnails/ subtitles/ exports/
 * Nadie puede leerlo públicamente: el acceso es solo con URLs firmadas que caducan.
 */
export class StorageStack extends Stack {
  readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);
    const protect = props.stage === "production" || props.protectData === true;

    this.bucket = new s3.Bucket(this, "Media", {
      bucketName: `${resourcePrefix(props.stage)}-media-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      // El navegador sube directo a S3: solo desde la web de ClipFlow.
      cors: [
        {
          allowedOrigins: props.webOrigins,
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedHeaders: ["*"],
          exposedHeaders: ["ETag"],
          maxAge: 3000,
        },
      ],
      lifecycleRules: [
        // Subidas abandonadas: S3 borra las partes para no pagar por ellas.
        { id: "abort-incomplete-uploads", abortIncompleteMultipartUploadAfter: Duration.days(2) },
        // Archivos temporales del worker.
        { id: "expire-tmp", prefix: "tmp/", expiration: Duration.days(1) },
      ],
      // Protegido: el bucket y los videos se conservan aunque se borre el stack.
      removalPolicy: protect ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !protect,
    });

    new CfnOutput(this, "BucketName", { value: this.bucket.bucketName });
  }
}
