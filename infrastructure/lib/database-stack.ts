import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import type { Construct } from "constructs";
import { resourcePrefix, type Stage } from "./stage.js";

export interface DatabaseStackProps extends StackProps {
  /** Proteger los datos contra borrado (también fuera de "production": hoy staging es el entorno real). */
  protectData?: boolean;
  stage: Stage;
  vpc: ec2.IVpc;
}

export const DATABASE_NAME = "clipflow";

/**
 * PostgreSQL 16 en Amazon RDS, en subredes sin internet.
 * La contraseña la genera AWS y se guarda en Secrets Manager (nadie la escribe a mano).
 */
export class DatabaseStack extends Stack {
  readonly instance: rds.DatabaseInstance;
  readonly securityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id, props);
    const isProd = props.stage === "production";
    const protect = isProd || props.protectData === true;
    const prefix = resourcePrefix(props.stage);

    this.securityGroup = new ec2.SecurityGroup(this, "DbSecurityGroup", {
      vpc: props.vpc,
      description: "PostgreSQL de ClipFlow: solo acepta a la API y al worker",
      allowAllOutbound: false,
    });

    this.instance = new rds.DatabaseInstance(this, "Postgres", {
      instanceIdentifier: `${prefix}-db`,
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.securityGroup],
      publiclyAccessible: false,
      databaseName: DATABASE_NAME,
      credentials: rds.Credentials.fromGeneratedSecret("clipflow_admin", { secretName: `${prefix}/db` }),
      allocatedStorage: 20,
      maxAllocatedStorage: 50,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      multiAz: isProd,
      backupRetention: Duration.days(7),
      deletionProtection: protect,
      removalPolicy: RemovalPolicy.SNAPSHOT,
      autoMinorVersionUpgrade: true,
      enablePerformanceInsights: false,
    });
  }
}
