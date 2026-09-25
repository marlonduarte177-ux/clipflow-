import type { ResourcesConfig } from "aws-amplify";

/**
 * Configuración de Cognito para Amplify.
 * Los valores vienen de variables NEXT_PUBLIC_* (no son secretos).
 * Next.js los incluye en el build, así que deben existir al compilar.
 */
const userPoolId = process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID ?? "";
const userPoolClientId = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID ?? "";

/** false si faltan las variables: la UI lo muestra en vez de fallar en silencio. */
export const authConfigured = userPoolId !== "" && userPoolClientId !== "";

export const amplifyConfig: ResourcesConfig = {
  Auth: {
    Cognito: {
      userPoolId,
      userPoolClientId,
      loginWith: { email: true },
      signUpVerificationMethod: "code",
    },
  },
};
