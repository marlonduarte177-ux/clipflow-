import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import type { Construct } from "constructs";
import { resourcePrefix, type Stage } from "./stage.js";

export interface AuthStackProps extends StackProps {
  stage: Stage;
}

/**
 * Autenticación con Amazon Cognito:
 * registro con email, verificación por código, login, recuperación de contraseña.
 * Cognito guarda y protege las contraseñas; ClipFlow nunca las ve.
 */
export class AuthStack extends Stack {
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);
    const isProd = props.stage === "production";
    const prefix = resourcePrefix(props.stage);

    this.userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `${prefix}-users`,
      // LITE cubre email + contraseña y es el plan más barato.
      featurePlan: cognito.FeaturePlan.LITE,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      keepOriginal: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      passwordPolicy: {
        minLength: 10,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
        tempPasswordValidity: Duration.days(3),
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      userVerification: {
        emailSubject: "ClipFlow: tu código de verificación",
        emailBody: "Tu código de verificación de ClipFlow es {####}",
        emailStyle: cognito.VerificationEmailStyle.CODE,
      },
      // Emails con el remitente por defecto de Cognito (límite bajo por día).
      // En producción se cambiará a Amazon SES con dominio propio.
      email: cognito.UserPoolEmail.withCognito(),
      deletionProtection: isProd,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    // Cliente público (navegador): sin secreto, login con SRP (la contraseña no viaja en claro).
    this.userPoolClient = this.userPool.addClient("WebClient", {
      userPoolClientName: `${prefix}-web`,
      generateSecret: false,
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      // Login social (Google) se activará después; por ahora sin OAuth.
      disableOAuth: true,
    });

    // IDs públicos (no son secretos): los usan el frontend y la API.
    new CfnOutput(this, "UserPoolId", { value: this.userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: this.userPoolClient.userPoolClientId });
  }
}
