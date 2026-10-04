import Link from "next/link";
import type { ReactNode } from "react";
import { LEGAL } from "@/lib/legal";
import { Logo } from "./logo";

export interface LegalSection {
  title: string;
  body: ReactNode;
}

export type LegalLang = "es" | "en";
export type LegalDoc = "terms" | "privacy" | "refunds";

/** Rutas de cada página legal en cada idioma. */
export const LEGAL_PATHS: Record<LegalDoc, Record<LegalLang, string>> = {
  terms: { es: "/terminos", en: "/en/terms" },
  privacy: { es: "/privacidad", en: "/en/privacy" },
  refunds: { es: "/reembolsos", en: "/en/refunds" },
};

const TEXT = {
  es: {
    updated: "Última actualización",
    app: "Ir a la app",
    terms: "Términos de uso",
    privacy: "Política de privacidad",
    refunds: "Reembolsos",
    legal: "Información legal",
    other: "English",
  },
  en: {
    updated: "Last updated",
    app: "Go to the app",
    terms: "Terms of Service",
    privacy: "Privacy Policy",
    refunds: "Refund Policy",
    legal: "Legal information",
    other: "Español",
  },
} as const;

const UPDATED_EN = "October 4, 2026";

/** Página legal pública (Términos, Privacidad, Reembolsos): misma estructura y estilo. */
export function LegalPage({
  doc,
  lang = "es",
  title,
  intro,
  sections,
}: {
  doc: LegalDoc;
  lang?: LegalLang;
  title: string;
  intro?: ReactNode;
  sections: LegalSection[];
}) {
  const t = TEXT[lang];
  return (
    <div lang={lang} className="flex flex-1 flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-line/60 px-5 py-3 sm:px-8">
        <Logo />
        <nav className="flex items-center gap-4 text-sm text-muted">
          <Link href={LEGAL_PATHS[doc][lang === "es" ? "en" : "es"]} hrefLang={lang === "es" ? "en" : "es"} className="hover:text-foreground">
            {t.other}
          </Link>
          <Link href="/dashboard" className="hover:text-foreground">
            {t.app}
          </Link>
        </nav>
      </header>
      <main className="mx-auto w-full max-w-2xl flex-1 px-5 py-8 sm:px-8">
        <h1 className="text-[28px] font-extrabold tracking-tight">{title}</h1>
        <p className="mt-1 text-sm text-muted">
          {t.updated}: {lang === "es" ? LEGAL.updated : UPDATED_EN}
        </p>
        {intro ? <div className="mt-5 space-y-3 text-[15px] leading-[24px] text-[#C9CDD4]">{intro}</div> : null}
        <div className="mt-6 space-y-7">
          {sections.map((s, i) => (
            <section key={s.title} className="space-y-2">
              <h2 className="text-lg font-bold">
                {i + 1}. {s.title}
              </h2>
              <div className="space-y-2 text-[15px] leading-[24px] text-[#C9CDD4] [&_li]:ml-5 [&_li]:list-disc [&_a]:text-accent [&_a]:underline">
                {s.body}
              </div>
            </section>
          ))}
        </div>
      </main>
      <LegalFooter lang={lang} />
    </div>
  );
}

/** Pie con los enlaces legales y el contacto (también en la página de inicio). */
export function LegalFooter({ lang = "es" }: { lang?: LegalLang }) {
  const t = TEXT[lang];
  return (
    <footer className="border-t border-line px-5 py-6 text-sm text-muted sm:px-8">
      <nav aria-label={t.legal} className="flex flex-wrap gap-x-5 gap-y-2">
        <Link href={LEGAL_PATHS.terms[lang]} className="hover:text-foreground">
          {t.terms}
        </Link>
        <Link href={LEGAL_PATHS.privacy[lang]} className="hover:text-foreground">
          {t.privacy}
        </Link>
        <Link href={LEGAL_PATHS.refunds[lang]} className="hover:text-foreground">
          {t.refunds}
        </Link>
        <Link href={LEGAL_PATHS.terms[lang === "es" ? "en" : "es"]} className="hover:text-foreground">
          {t.other}
        </Link>
        <a href={`mailto:${LEGAL.email}`} className="hover:text-foreground">
          {LEGAL.email}
        </a>
      </nav>
      <p className="mt-3">© 2026 ClipFlow · {LEGAL.owner} · {lang === "es" ? LEGAL.country : "Costa Rica"}</p>
    </footer>
  );
}
