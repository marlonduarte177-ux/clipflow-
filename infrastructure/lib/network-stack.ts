import { Stack, type StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import type { Construct } from "constructs";
import { resourcePrefix, type Stage } from "./stage.js";

export interface NetworkStackProps extends StackProps {
  stage: Stage;
}

/**
 * Red privada (VPC) en 2 zonas:
 * - Subredes públicas: contenedores de API y worker (sin conexiones entrantes desde internet;
 *   lo controlan sus security groups).
 * - Subredes aisladas: base de datos, SIN ninguna ruta a internet.
 * Sin NAT Gateway (ahorra ~33 USD/mes). El tráfico a S3 va por un endpoint privado gratuito.
 */
export class NetworkStack extends Stack {
  readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);
    this.vpc = new ec2.Vpc(this, "Vpc", {
      vpcName: `${resourcePrefix(props.stage)}-vpc`,
      ipAddresses: ec2.IpAddresses.cidr("10.0.0.0/16"),
      availabilityZones: [`${this.region}a`, `${this.region}b`],
      natGateways: 0,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24, mapPublicIpOnLaunch: false },
        { name: "db", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      gatewayEndpoints: {
        S3: { service: ec2.GatewayVpcEndpointAwsService.S3 },
      },
    });
  }
}
