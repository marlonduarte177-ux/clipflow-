"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { Locale } from "@clipflow/shared";
import { saveLocaleCookie } from "./locale";
import { MESSAGES, type Messages } from "./messages";

const LocaleContext = createContext<{ locale: Locale; setLocale: (locale: Locale) => void } | null>(null);

/** Idioma de la app en el navegador. El servidor manda el inicial (cookie o idioma del navegador). */
export function LocaleProvider({ initial, children }: { initial: Locale; children: ReactNode }) {
  const router = useRouter();
  const [locale, setState] = useState(initial);
  const setLocale = useCallback(
    (next: Locale) => {
      saveLocaleCookie(next);
      setState(next);
      document.documentElement.lang = next;
      // Las partes que arma el servidor (títulos, páginas) se vuelven a pedir en el idioma nuevo.
      router.refresh();
    },
    [router],
  );
  const value = useMemo(() => ({ locale, setLocale }), [locale, setLocale]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error("useLocale fuera de LocaleProvider");
  return ctx;
}

/** Textos de la interfaz en el idioma actual. */
export function useT(): Messages {
  return MESSAGES[useLocale().locale];
}
