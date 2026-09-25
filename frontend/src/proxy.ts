import { NextResponse, type NextRequest } from "next/server";
import { fetchAuthSession } from "aws-amplify/auth/server";
import { authConfigured } from "@/lib/amplify-config";
import { runWithAmplifyServerContext } from "@/lib/amplify-server";

/**
 * Protección de rutas: si no hay sesión válida, redirige a /login.
 * (Las páginas protegidas vuelven a comprobar la sesión en el servidor.)
 */
export async function proxy(request: NextRequest) {
  const response = NextResponse.next();

  const authenticated =
    authConfigured &&
    (await runWithAmplifyServerContext({
      nextServerContext: { request, response },
      operation: async (contextSpec) => {
        try {
          const session = await fetchAuthSession(contextSpec);
          return session.tokens?.accessToken !== undefined;
        } catch {
          return false;
        }
      },
    }));

  if (authenticated) return response;

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/dashboard/:path*"],
};
