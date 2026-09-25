import { describe, expect, it } from "vitest";
import { createCognitoVerifier } from "./auth.js";

describe("createCognitoVerifier (verificador real de Cognito)", () => {
  const verify = createCognitoVerifier("us-east-1_TEST12345", "test-client");

  it("rechaza tokens que no son JWT", async () => {
    await expect(verify("aaa.bbb.ccc")).rejects.toThrow();
  });

  it("rechaza un JWT sin firmar (alg none)", async () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${b64({ alg: "none", typ: "JWT" })}.${b64({
      sub: "attacker",
      token_use: "access",
      client_id: "test-client",
      iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TEST12345",
      exp: Math.floor(Date.now() / 1000) + 3600,
    })}.`;
    await expect(verify(unsigned)).rejects.toThrow();
  });
});
