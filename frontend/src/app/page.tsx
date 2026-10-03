import Link from "next/link";
import { LegalFooter } from "@/components/legal-page";
import { Logo } from "@/components/ui";
import { getLocale, getT } from "@/i18n/server";

export default async function Home() {
  const [t, locale] = await Promise.all([getT(), getLocale()]);
  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between px-4 py-4 sm:px-8">
        <Logo />
        <nav className="flex items-center gap-2 text-sm">
          <Link href="/login" className="rounded-lg px-3 py-1.5 text-muted hover:text-foreground">
            {t.home.signIn}
          </Link>
          <Link href="/registro" className="rounded-lg bg-accent px-3 py-1.5 font-medium text-on-accent">
            {t.home.signUp}
          </Link>
        </nav>
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 sm:px-8">
        <section className="py-16 sm:py-24">
          <h1 className="max-w-2xl text-4xl font-semibold leading-tight tracking-tight sm:text-6xl">{t.home.title}</h1>
          <p className="mt-5 max-w-xl text-lg text-muted">{t.home.subtitle}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/registro" className="rounded-lg bg-accent px-5 py-3 font-medium text-on-accent">
              {t.home.start}
            </Link>
            <Link href="/login" className="rounded-lg border border-line px-5 py-3 text-muted hover:text-foreground">
              {t.home.haveAccount}
            </Link>
          </div>
        </section>

        <section aria-labelledby="como-funciona" className="pb-20">
          <h2 id="como-funciona" className="text-sm font-medium uppercase tracking-widest text-muted">
            {t.home.how}
          </h2>
          <ol className="mt-6 grid gap-4 sm:grid-cols-3">
            {t.home.steps.map((step, i) => (
              <li key={step.title} className="rounded-2xl border border-line bg-surface p-5">
                <span className="text-sm text-accent">{i + 1}</span>
                <h3 className="mt-2 font-medium">{step.title}</h3>
                <p className="mt-1 text-sm text-muted">{step.text}</p>
              </li>
            ))}
          </ol>
        </section>
      </main>

      <LegalFooter lang={locale} />
    </div>
  );
}
