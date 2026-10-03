import { clientLocale } from "@/i18n/locale";
import { MESSAGES } from "@/i18n/messages";

/** Traduce los errores de Cognito/Amplify a mensajes claros en el idioma de la app. */
export function authErrorMessage(error: unknown): string {
  const t = MESSAGES[clientLocale()].auth;
  const name = error instanceof Error ? error.name : undefined;
  if (name && t.errors[name]) return t.errors[name];
  return t.genericError;
}

export function authErrorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}
