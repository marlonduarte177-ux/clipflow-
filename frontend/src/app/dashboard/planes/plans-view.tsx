"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  MONTHLY_PLANS,
  PLANS,
  type BillingResponse,
  type MonthlyPlanCode,
} from "@clipflow/shared";
import { BackIcon, CheckIcon } from "@/components/icons";
import { Alert } from "@/components/ui";
import { errorMessage } from "@/i18n/locale";
import { useLocale, useT } from "@/i18n/provider";
import { apiFetch } from "@/lib/api";

const allows = (b: BillingResponse | null) =>
  b?.subscription?.status === "trialing" ||
  b?.subscription?.status === "active" ||
  b?.subscription?.status === "past_due";

export function PlansView() {
  const t = useT();
  const { locale } = useLocale();
  const [billing, setBilling] = useState<BillingResponse | null>(null);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState<MonthlyPlanCode | "portal" | null>(
    null,
  );
  const [activating, setActivating] = useState(false);
  const [activated, setActivated] = useState(false);
  const polling = useRef(false);

  const refresh = useCallback(
    () => apiFetch<BillingResponse>("/billing").then(setBilling),
    [],
  );

  // Al volver del pago (?pago=ok), Polar avisa a ClipFlow por su cuenta: se espera a que el plan aparezca.
  const waitForPlan = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    setActivating(true);
    for (let i = 0; i < 30; i++) {
      const next = await apiFetch<BillingResponse>("/billing").catch(
        () => null,
      );
      if (next) setBilling(next);
      if (allows(next) && (next?.creditMinutes ?? 0) > 0) {
        setActivated(true);
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    setActivating(false);
    polling.current = false;
  }, []);

  /** ¿Volvió del pago? Se lee una vez (y se quita de la dirección para que recargar no espere otra vez). */
  const returned = useRef<boolean | null>(null);

  useEffect(() => {
    if (returned.current === null) {
      const url = new URL(window.location.href);
      returned.current = url.searchParams.get("pago") === "ok";
      url.searchParams.delete("pago");
      window.history.replaceState(null, "", url.pathname + url.search);
    }
    if (returned.current) {
      const timer = setTimeout(() => void waitForPlan(), 0);
      return () => clearTimeout(timer);
    }
    refresh().catch((err: Error) => setError(errorMessage(err)));
  }, [refresh, waitForPlan]);

  /** Abre el pago de Polar (en su página) o «Gestionar suscripción». */
  async function go(target: MonthlyPlanCode | "portal") {
    setError("");
    setOpening(target);
    try {
      const { url } =
        target === "portal"
          ? await apiFetch<{ url: string }>("/billing/portal", {
              method: "POST",
            })
          : await apiFetch<{ url: string }>("/billing/checkout", {
              method: "POST",
              body: { plan: target },
            });
      window.location.assign(url);
    } catch (err) {
      setError(errorMessage(err as Error));
      setOpening(null);
      void refresh().catch(() => undefined);
    }
  }

  const date = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleDateString(locale, {
          day: "numeric",
          month: "long",
        })
      : "";
  const sub = billing?.subscription;
  const hasPlan = allows(billing);
  const isTrial = hasPlan && sub?.planCode === "trial";
  const ready = Boolean(billing?.checkoutReady);
  const busy = !ready || opening !== null || activating;

  return (
    <div className="mx-auto max-w-xl">
      <Link
        href="/dashboard/cuenta"
        className="inline-flex items-center gap-1 text-sm text-muted hover:text-foreground"
      >
        <BackIcon size={18} />
        {t.meta.account}
      </Link>
      <h1 className="mt-4 text-[28px] font-extrabold tracking-tight">
        {t.plans.title}
      </h1>

      <div className="mt-5 space-y-4">
        <Alert kind="error">{error}</Alert>
        {activating ? <Alert kind="info">{t.plans.activating}</Alert> : null}
        {activated ? <Alert kind="info">{t.plans.activated}</Alert> : null}

        {!billing ? (
          error ? null : (
            <p className="text-sm text-muted">{t.common.loading}</p>
          )
        ) : billing.exempt ? (
          <Card>
            <p className="text-base font-semibold">{t.plans.exempt}</p>
            <p className="mt-1 text-[15px] text-[#8B909A]">
              {t.plans.minutesLeft(billing.creditMinutes)}
            </p>
          </Card>
        ) : (
          <>
            {hasPlan && sub ? (
              <Card>
                <p className="text-sm text-[#8B909A]">{t.plans.current}</p>
                <div className="mt-1 flex items-center gap-2">
                  <p className="text-xl font-bold">
                    {t.plans.names[sub.planCode]}
                  </p>
                  <span className="inline-flex h-6 items-center rounded-full bg-accent px-2.5 text-[13px] font-bold text-on-accent">
                    {t.plans.status[sub.status]}
                  </span>
                </div>
                <p className="mt-3 text-[15px]">
                  {t.plans.minutesLeft(billing.creditMinutes)}
                </p>
                {sub.currentPeriodEnd ? (
                  <p className="mt-1 text-[15px] text-[#8B909A]">
                    {isTrial || sub.cancelAtPeriodEnd
                      ? t.plans.ends(date(sub.currentPeriodEnd))
                      : t.plans.renews(date(sub.currentPeriodEnd))}
                  </p>
                ) : null}
                {isTrial && !sub.cancelAtPeriodEnd ? (
                  <p className="mt-3 text-sm text-[#8B909A]">
                    {t.plans.trialUpgrade}
                  </p>
                ) : null}
                {sub.status === "past_due" ? (
                  <p className="mt-3 text-sm text-red-300">{t.plans.pastDue}</p>
                ) : null}
                {billing.portalAvailable ? (
                  <>
                    <button
                      type="button"
                      onClick={() => go("portal")}
                      disabled={opening !== null}
                      className="mt-4 flex h-12 w-full items-center justify-center rounded-2xl border border-line text-[15px] font-semibold disabled:opacity-50"
                    >
                      {opening === "portal" ? t.plans.opening : t.plans.manage}
                    </button>
                    <p className="mt-2 text-center text-xs text-[#8B909A]">
                      {t.plans.manageHint}
                    </p>
                  </>
                ) : null}
              </Card>
            ) : null}
            {/* Sin plan: la prueba gratis (si nunca tuvo plan) y los planes mensuales. */}
            {!hasPlan ? (
              <>
                {ready ? null : (
                  <Alert kind="info">{t.plans.unavailable}</Alert>
                )}
                {billing.trialEligible ? (
                  <PlanCard
                    name={t.plans.names.trial}
                    price={t.plans.trialFree}
                    period={t.plans.trialPeriod}
                    minutes={t.plans.minutes(PLANS.trial.minutes)}
                    note={`${t.plans.trialThen} ${t.plans.trialCard}`}
                    action={
                      ready
                        ? opening === "basic"
                          ? t.plans.opening
                          : t.plans.startTrial
                        : t.plans.soon
                    }
                    onAction={() => go("basic")}
                    busy={busy}
                    highlight
                  />
                ) : null}
                {MONTHLY_PLANS.map((plan) => (
                  <PlanCard
                    key={plan}
                    name={t.plans.names[plan]}
                    price={usd(PLANS[plan].priceUsd)}
                    period={t.plans.perMonth}
                    minutes={t.plans.monthlyMinutes(PLANS[plan].minutes)}
                    badge={plan === "pro" ? t.plans.popular : undefined}
                    action={
                      ready
                        ? opening === plan
                          ? t.plans.opening
                          : t.plans.choose(t.plans.names[plan])
                        : t.plans.soon
                    }
                    onAction={() => go(plan)}
                    busy={busy}
                    highlight={!billing.trialEligible && plan === "pro"}
                  />
                ))}
                <ul className="space-y-2 px-1 text-[15px]">
                  {t.plans.features.map((f) => (
                    <li key={f} className="flex items-center gap-2">
                      <CheckIcon size={16} className="shrink-0 text-accent" />
                      {f}
                    </li>
                  ))}
                </ul>
                <p className="px-1 text-sm text-[#8B909A]">
                  {t.plans.noRollover}
                </p>
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-[#1C2029] bg-[#12151B] px-5 py-5">
      {children}
    </section>
  );
}

const usd = (n: number) => `$${n.toFixed(2)}`;

function PlanCard(props: {
  name: string;
  price: string;
  period: string;
  minutes: string;
  note?: string;
  badge?: string;
  action: string | null;
  onAction: () => void;
  busy: boolean;
  highlight?: boolean;
}) {
  return (
    <section
      className={`rounded-2xl border px-5 py-5 ${props.highlight ? "border-accent/60 bg-accent/[0.06]" : "border-[#1C2029] bg-[#12151B]"}`}
    >
      <div className="flex items-center gap-2">
        <p className="text-lg font-bold">{props.name}</p>
        {props.badge ? (
          <span className="inline-flex h-6 items-center rounded-full bg-accent px-2.5 text-[12px] font-bold text-on-accent">
            {props.badge}
          </span>
        ) : null}
      </div>
      <p className="mt-1">
        <span className="text-[28px] font-extrabold tracking-tight">
          {props.price}
        </span>{" "}
        <span className="text-[15px] text-[#8B909A]">{props.period}</span>
      </p>
      <p className="mt-1 text-[15px]">{props.minutes}</p>
      {props.note ? (
        <p className="mt-2 text-sm text-[#8B909A]">{props.note}</p>
      ) : null}
      {props.action ? (
        <button
          type="button"
          onClick={props.onAction}
          disabled={props.busy}
          className={`mt-4 h-12 w-full rounded-2xl text-[15px] font-bold disabled:opacity-50 ${
            props.highlight ? "bg-accent text-on-accent" : "border border-line"
          }`}
        >
          {props.action}
        </button>
      ) : null}
    </section>
  );
}
