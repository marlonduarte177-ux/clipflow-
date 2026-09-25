import type { FastifyReply, FastifyRequest } from "fastify";
import { CognitoJwtVerifier } from "aws-jwt-verify";

/** Usuario autenticado, extraído de un access token de Cognito ya verificado. */
export interface AuthUser {
  /** `sub` de Cognito: identificador estable del usuario. */
  userId: string;
}

/** Verifica un token y devuelve el usuario, o lanza un error si no es válido. */
export type TokenVerifier = (token: string) => Promise<AuthUser>;

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

/**
 * Verificador real: comprueba firma (claves públicas de Cognito), expiración,
 * emisor (user pool), tipo de token ("access") y app client.
 */
export function createCognitoVerifier(userPoolId: string, clientId: string): TokenVerifier {
  const verifier = CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: "access" });
  return async (token) => {
    const payload = await verifier.verify(token);
    return { userId: payload.sub };
  };
}

/** preHandler de Fastify: exige `Authorization: Bearer <token>` válido. */
export function requireAuth(verify: TokenVerifier) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;
    const match = header?.match(/^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/);
    if (!match?.[1]) {
      return reply.code(401).send({
        error: { code: "unauthorized", message: "Inicia sesión para continuar." },
      });
    }
    try {
      request.user = await verify(match[1]);
    } catch (err) {
      // No se registra el token, solo el motivo.
      request.log.info({ reason: (err as Error).name }, "token rechazado");
      return reply.code(401).send({
        error: { code: "unauthorized", message: "Tu sesión no es válida o expiró." },
      });
    }
  };
}
