"use client";

import Link from "next/link";
import { LOCALES } from "@clipflow/shared";
import { BackIcon, CheckIcon } from "@/components/icons";
import { LOCALE_NAMES } from "@/i18n/messages";
import { useLocale, useT } from "@/i18n/provider";

/** Elegir el idioma de la app; se guarda en una cookie y se aplica al momento. */
export function LanguagePicker() {
  const t = useT();
  const { locale, setLocale } = useLocale();
  return (
    <div className="mx-auto max-w-xl">
      <Link href="/dashboard/cuenta" className="inline-flex items-center gap-1 text-sm text-muted hover:text-foreground">
        <BackIcon size={18} />
        {t.account.title}
      </Link>
      <h1 className="mt-4 text-[28px] font-extrabold tracking-tight">{t.languagePage.title}</h1>
      <div role="radiogroup" aria-label={t.languagePage.title} className="mt-5 overflow-hidden rounded-2xl border border-[#1C2029] bg-[#12151B]">
        {LOCALES.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={locale === option}
            lang={option}
            onClick={() => setLocale(option)}
            className="flex h-12 w-full items-center justify-between border-b border-[#1C2029] px-4 text-left text-base text-[#F3F4F6] last:border-b-0 hover:bg-white/[0.03]"
          >
            {LOCALE_NAMES[option]}
            {locale === option ? <CheckIcon size={18} strokeWidth={2.6} className="text-accent" /> : null}
          </button>
        ))}
      </div>
      <p className="mt-3 text-xs leading-[18px] text-muted">{t.languagePage.hint}</p>
    </div>
  );
}
