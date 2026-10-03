import Link from "next/link";
import type { ReactNode } from "react";
import { LEGAL } from "@/lib/legal";
import { Logo } from "./logo";

export interface LegalSection {
  title: string;
  body: ReactNode;
}

/** Página legal pública (Términos, Privacidad, Reembolsos): misma estructura y estilo. */
export function LegalPage({ title, intro, sections }: { title: string; intro?: ReactNode; sections: LegalSection[] }) {
  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-line/60 px-5 py-3 sm:px-8">
        <Logo />
        <Link href="/dashboard" className="text-sm text-muted hover:text-foreground">
          Ir a la app
        </Link>
      </header>
      <main className="mx-auto w-full max-w-2xl flex-1 px-5 py-8 sm:px-8">
        <h1 className="text-[28px] font-extrabold tracking-tight">{title}</h1>
        <p className="mt-1 text-sm text-muted">Última actualización: {LEGAL.updated}</p>
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
      <LegalFooter />
    </div>
  );
}

/** Pie con los enlaces legales y el contacto (también en la página de inicio). */
export function LegalFooter() {
  return (
    <footer className="border-t border-line px-5 py-6 text-sm text-muted sm:px-8">
      <nav aria-label="Información legal" className="flex flex-wrap gap-x-5 gap-y-2">
        <Link href="/terminos" className="hover:text-foreground">
          Términos de uso
        </Link>
        <Link href="/privacidad" className="hover:text-foreground">
          Política de privacidad
        </Link>
        <Link href="/reembolsos" className="hover:text-foreground">
          Reembolsos
        </Link>
        <a href={`mailto:${LEGAL.email}`} className="hover:text-foreground">
          {LEGAL.email}
        </a>
      </nav>
      <p className="mt-3">© 2026 ClipFlow · {LEGAL.owner} · {LEGAL.country}</p>
    </footer>
  );
}
