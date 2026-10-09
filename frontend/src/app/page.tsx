import Link from "next/link";
import { MONTHLY_PLANS, PLANS } from "@clipflow/shared";
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
        <section aria-labelledby="precios" className="pb-20">
          <h2 id="precios" className="text-sm font-medium uppercase tracking-widest text-muted">
            {t.home.pricing}
          </h2>
          <p className="mt-2 text-sm text-muted">{t.home.pricingText}</p>
          {/* Cada plan lleva a crear la cuenta; el pago se hace adentro, en Planes. */}
          <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {(["trial", ...MONTHLY_PLANS] as const).map((code) => {
              const plan = PLANS[code];
              const trial = code === "trial";
              return (
                <li key={code}>
                  <Link
                    href="/registro"
                    className={`flex h-full flex-col rounded-2xl border bg-surface p-5 transition hover:border-accent ${
                      code === "pro" ? "border-accent" : "border-line"
                    }`}
                  >
                    <span className="font-semibold">{t.plans.names[code]}</span>
                    {code === "pro" ? <span className="mt-1 text-xs text-accent">{t.plans.popular}</span> : null}
                    <span className="mt-3 text-3xl font-extrabold">
                      ${plan.priceUsd.toFixed(2)}
                      <span className="ml-1 text-sm font-normal text-muted">{trial ? t.plans.trialPeriod : t.plans.perMonth}</span>
                    </span>
                    <span className="mt-2 text-sm text-muted">
                      {trial ? t.plans.minutes(plan.minutes) : t.plans.monthlyMinutes(plan.minutes)}
                    </span>
                    {trial ? <span className="mt-1 text-xs text-muted">{t.plans.trialThen}</span> : null}
                    <span className="mt-auto pt-4 text-sm font-medium text-accent">{t.home.pricingCta} →</span>
                  </Link>
                </li>
              );
            })}
          </ul>
          <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
            {[...t.plans.features, t.plans.noRollover].map((f) => (
              <li key={f}>· {f}</li>
            ))}
          </ul>
        </section>
      </main>

      <LegalFooter lang={locale} />
    </div>
  );
}
