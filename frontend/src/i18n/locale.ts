import { DEFAULT_LOCALE, isLocale, translateMessage, type Locale } from "@clipflow/shared";

/** Cookie con el idioma elegido (la leen el servidor y el navegador). */
export const LOCALE_COOKIE = "clipflow-lang";

/** Idioma a partir de la cookie y, si no hay, del idioma del navegador (Accept-Language). */
export function resolveLocale(cookie: string | undefined | null, acceptLanguage?: string | null): Locale {
  if (isLocale(cookie)) return cookie;
  const first = acceptLanguage?.split(",")[0]?.trim().toLowerCase() ?? "";
  if (first.startsWith("en")) return "en";
  return DEFAULT_LOCALE;
}

/** Idioma actual en el navegador (para código fuera de React, como las llamadas a la API). */
export function clientLocale(): Locale {
  if (typeof document === "undefined") return DEFAULT_LOCALE;
  const match = document.cookie.match(new RegExp(`(?:^|; )${LOCALE_COOKIE}=([^;]+)`));
  return resolveLocale(match?.[1], typeof navigator === "undefined" ? null : navigator.language);
}

export function saveLocaleCookie(locale: Locale) {
  // Un año; disponible en toda la web.
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
}

/** Mensaje de un error para mostrarlo, traducido al idioma actual (los del servidor llegan en español). */
export function errorMessage(err: unknown): string {
  return translateMessage(err instanceof Error ? err.message : String(err), clientLocale());
}
