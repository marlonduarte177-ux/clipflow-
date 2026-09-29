import type { FastifyReply, FastifyRequest } from "fastify";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { CognitoIdentityProviderClient, GetUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import { findUserByCognitoSub, upsertUser, type Database } from "@clipflow/shared/db";

/** Resultado de verificar un access token de Cognito. */
export interface VerifiedToken {
  cognitoSub: string;
}

/** Usuario de ClipFlow asociado a la petición. */
export interface AuthUser {
  /** Id interno (tabla users). Es el que se usa en TODAS las consultas. */
  id: string;
  cognitoSub: string;
  email: string | null;
}

/** Verifica un token o lanza un error si no es válido. */
export type TokenVerifier = (token: string) => Promise<VerifiedToken>;

/** Obtiene el email del usuario desde Cognito (solo la primera vez que entra). */
export type EmailLookup = (accessToken: string) => Promise<string | null>;

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
    return { cognitoSub: payload.sub };
  };
}

export function createCognitoEmailLookup(region: string): EmailLookup {
  const client = new CognitoIdentityProviderClient({ region });
  return async (accessToken) => {
    const result = await client.send(new GetUserCommand({ AccessToken: accessToken }));
    return result.UserAttributes?.find((a) => a.Name === "email")?.Value ?? null;
  };
}

function unauthorized(reply: FastifyReply, message: string) {
  return reply.code(401).send({ error: { code: "unauthorized", message } });
}

/**
 * preHandler de Fastify: exige `Authorization: Bearer <token>` válido y
 * carga (o crea la primera vez) el usuario en la base de datos.
 */
export function requireAuth(deps: { verifyToken: TokenVerifier; lookupEmail: EmailLookup; db: Database }) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const match = request.headers.authorization?.match(/^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/);
    if (!match?.[1]) return unauthorized(reply, "Inicia sesión para continuar.");
    const token = match[1];

    let verified: VerifiedToken;
    try {
      verified = await deps.verifyToken(token);
    } catch (err) {
      // Nunca se registra el token, solo el motivo.
      request.log.info({ reason: (err as Error).name }, "token rechazado");
      return unauthorized(reply, "Tu sesión no es válida o expiró.");
    }

    let user = await findUserByCognitoSub(deps.db, verified.cognitoSub);
    if (!user) {
      const email = await deps.lookupEmail(token).catch((err: Error) => {
        request.log.warn({ reason: err.name }, "no se pudo leer el email en Cognito");
        return null;
      });
      user = await upsertUser(deps.db, { cognitoSub: verified.cognitoSub, email });
      request.log.info({ userId: user.id }, "usuario creado");
    }
    if (user.deletedAt) return unauthorized(reply, "Esta cuenta está desactivada.");

    request.user = { id: user.id, cognitoSub: user.cognitoSub, email: user.email };
  };
}
