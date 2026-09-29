import { describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AuthStack } from "../lib/auth-stack.js";
import { parseStage } from "../lib/stage.js";

function synth(stage: "staging" | "production") {
  const app = new App();
  return Template.fromStack(new AuthStack(app, `test-${stage}`, { stage }));
}

describe("AuthStack", () => {
  it("crea un user pool con registro por email verificado y contraseña fuerte", () => {
    synth("staging").hasResourceProperties("AWS::Cognito::UserPool", {
      UserPoolName: "clipflow-staging-users",
      UsernameAttributes: ["email"],
      AutoVerifiedAttributes: ["email"],
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: false },
      Policies: {
        PasswordPolicy: Match.objectLike({
          MinimumLength: 10,
          RequireLowercase: true,
          RequireUppercase: true,
          RequireNumbers: true,
        }),
      },
      AccountRecoverySetting: {
        RecoveryMechanisms: [{ Name: "verified_email", Priority: 1 }],
      },
    });
  });

  it("el cliente web no tiene secreto, usa SRP y no revela si un usuario existe", () => {
    synth("staging").hasResourceProperties("AWS::Cognito::UserPoolClient", {
      GenerateSecret: false,
      ExplicitAuthFlows: Match.arrayWith(["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]),
      PreventUserExistenceErrors: "ENABLED",
      AllowedOAuthFlowsUserPoolClient: false,
    });
  });

  it("en producción el user pool está protegido contra borrado", () => {
    const template = synth("production");
    template.hasResourceProperties("AWS::Cognito::UserPool", { DeletionProtection: "ACTIVE" });
    template.hasResource("AWS::Cognito::UserPool", { DeletionPolicy: "Retain" });
  });

  it("en staging el user pool se puede borrar", () => {
    synth("staging").hasResource("AWS::Cognito::UserPool", { DeletionPolicy: "Delete" });
  });

  it("publica los IDs que necesitan frontend y API", () => {
    const outputs = synth("staging").findOutputs("*");
    expect(Object.keys(outputs)).toEqual(expect.arrayContaining(["UserPoolId", "UserPoolClientId"]));
  });
});

describe("parseStage", () => {
  it("acepta solo entornos conocidos", () => {
    expect(parseStage("staging")).toBe("staging");
    expect(() => parseStage(undefined)).toThrow(/-c stage=/);
    expect(() => parseStage("prod")).toThrow();
  });
});
