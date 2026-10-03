import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { fetchAuthSession, fetchUserAttributes } from "aws-amplify/auth/server";
import { authConfigured } from "./amplify-config";
import { runWithAmplifyServerContext } from "./amplify-server";

export interface SessionUser {
  userId: string;
  email: string;
  /** Nombre guardado en Cognito (atributo "name"), si lo hay. */
  name: string | null;
}

/** Devuelve el usuario de la sesión actual o redirige a /login. Usar en páginas protegidas. */
export async function requireUser(): Promise<SessionUser> {
  if (!authConfigured) redirect("/login");
  const user = await runWithAmplifyServerContext({
    nextServerContext: { cookies },
    operation: async (contextSpec) => {
      try {
        const session = await fetchAuthSession(contextSpec);
        const userId = session.tokens?.accessToken.payload.sub;
        if (!userId) return null;
        const attributes = await fetchUserAttributes(contextSpec);
        return { userId, email: attributes.email ?? "", name: attributes.name?.trim() || null };
      } catch {
        return null;
      }
    },
  });
  if (!user) redirect("/login?next=/dashboard");
  return user;
}
