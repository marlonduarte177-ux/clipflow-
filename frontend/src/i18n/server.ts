import "server-only";
import { cookies, headers } from "next/headers";
import type { Locale } from "@clipflow/shared";
import { LOCALE_COOKIE, resolveLocale } from "./locale";
import { MESSAGES, type Messages } from "./messages";

/** Idioma de la petición actual (componentes de servidor). */
export async function getLocale(): Promise<Locale> {
  const [jar, h] = await Promise.all([cookies(), headers()]);
  return resolveLocale(jar.get(LOCALE_COOKIE)?.value, h.get("accept-language"));
}

export async function getT(): Promise<Messages> {
  return MESSAGES[await getLocale()];
}

/** Título de la pestaña: "<página> · ClipFlow" en el idioma de la petición. */
export async function pageTitle(key: keyof Messages["meta"]): Promise<string> {
  const t = await getT();
  return `${t.meta[key]} · ClipFlow`;
}
