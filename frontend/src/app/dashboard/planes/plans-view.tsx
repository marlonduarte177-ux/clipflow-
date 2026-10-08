"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { MONTHLY_PLANS, PLANS, type BillingResponse, type PlanCode } from "@clipflow/shared";
import { BackIcon, CheckIcon } from "@/components/icons";
import { Alert } from "@/components/ui";
import { errorMessage } from "@/i18n/locale";
import { useLocale, useT } from "@/i18n/provider";
import { apiFetch } from "@/lib/api";

/** Paddle.js (pagos). Se carga solo en esta página. */
const PADDLE_JS = "https://cdn.paddle.com/paddle/v2/paddle.js";

interface PaddleGlobal {
  Environment: { set: (env: "sandbox") => void };
  Initialize: (options: { token: string; eventCallback?: (event: PaddleEvent) => void }) => void;
  Checkout: {
    open: (options: {
      items: { priceId: string; quantity: number }[];
      customer?: { email: string };
      customData?: Record<string, string>;
      discountId?: string;
      settings?: { displayMode?: "overlay"; theme?: "dark" | "light"; locale?: string; allowLogout?: boolean };
    }) => void;
  };
}
declare global {
  interface Window {
    Paddle?: PaddleGlobal;
  }
}

/** Aviso de Paddle.js (pago completado, error del pago…). */
interface PaddleEvent {
  name?: string;
  type?: string;
  code?: string;
  detail?: string;
  error?: { code?: string; detail?: string };
}

let paddleReady: Promise<PaddleGlobal> | null = null;
/** Paddle se inicializa una vez: los avisos van siempre a la página que está abierta. */
let paddleListener: ((event: PaddleEvent) => void) | null = null;
function loadPaddle(checkout: NonNullable<BillingResponse["checkout"]>, onEvent: (event: PaddleEvent) => void): Promise<PaddleGlobal> {
  paddleListener = onEvent;
  paddleReady ??= new Promise<PaddleGlobal>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = PADDLE_JS;
    script.async = true;
    script.onload = () => {
      const paddle = window.Paddle;
      if (!paddle) return reject(new Error("Paddle no cargó"));
      if (checkout.environment === "sandbox") paddle.Environment.set("sandbox");
      paddle.Initialize({ token: checkout.clientToken, eventCallback: (e) => paddleListener?.(e) });
      resolve(paddle);
    };
    script.onerror = () => {
      paddleReady = null;
      reject(new Error("Paddle no cargó"));
    };
    document.head.appendChild(script);
  });
  return paddleReady;
}

const allows = (b: BillingResponse | null) =>
  b?.subscription?.status === "trialing" || b?.subscription?.status === "active" || b?.subscription?.status === "past_due";

export function PlansView() {
  const t = useT();
  const { locale } = useLocale();
  const [billing, setBilling] = useState<BillingResponse | null>(null);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState<PlanCode | null>(null);
  const [activating, setActivating] = useState(false);
  const [activated, setActivated] = useState(false);
  const polling = useRef(false);

  const refresh = useCallback(() => apiFetch<BillingResponse>("/billing").then(setBilling), []);

  useEffect(() => {
    refresh().catch((err: Error) => setError(errorMessage(err)));
  }, [refresh]);

  // Tras pagar, Paddle avisa a ClipFlow por su cuenta: se espera a que el plan aparezca activo.
  const waitForPlan = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    setActivating(true);
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const next = await apiFetch<BillingResponse>("/billing").catch(() => null);
      if (next) setBilling(next);
      if (allows(next) && (next?.creditMinutes ?? 0) > 0) {
        setActivated(true);
        break;
      }
    }
    setActivating(false);
    polling.current = false;
  }, []);

  async function onBuy(plan: PlanCode) {
    const checkout = billing?.checkout;
    const option = checkout?.options.find((o) => o.plan === plan);
    if (!checkout || !option) return;
    setError("");
    setOpening(plan);
    try {
      const paddle = await loadPaddle(checkout, (event) => {
        const name = event.name ?? event.type;
        if (name === "checkout.completed") void waitForPlan();
        // Paddle rechazó el pago por su configuración: se muestra su código para poder corregirlo.
        if (name === "checkout.error") {
          const code = event.error?.code ?? event.code ?? event.error?.detail ?? event.detail;
          setError(code ? `${t.plans.failed} (${code})` : t.plans.failed);
        }
      });
      paddle.Checkout.open({
        items: option.items,
        ...(option.discountId ? { discountId: option.discountId } : {}),
        ...(checkout.email ? { customer: { email: checkout.email } } : {}),
        customData: checkout.customData,
        settings: { displayMode: "overlay", theme: "dark", locale, allowLogout: false },
      });
    } catch {
      setError(t.plans.failed);
    } finally {
      setOpening(null);
    }
  }

  const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(locale, { day: "numeric", month: "long" }) : "");
  const sub = billing?.subscription;
  const hasPlan = allows(billing);

  return (
    <div className="mx-auto max-w-xl">
      <Link href="/dashboard/cuenta" className="inline-flex items-center gap-1 text-sm text-muted hover:text-foreground">
        <BackIcon size={18} />
        {t.meta.account}
      </Link>
      <h1 className="mt-4 text-[28px] font-extrabold tracking-tight">{t.plans.title}</h1>

      <div className="mt-5 space-y-4">
        <Alert kind="error">{error}</Alert>
        {activating ? <Alert kind="info">{t.plans.activating}</Alert> : null}
        {activated ? <Alert kind="info">{t.plans.activated}</Alert> : null}

        {!billing ? (
          error ? null : <p className="text-sm text-muted">{t.common.loading}</p>
        ) : billing.exempt ? (
          <Card>
            <p className="text-base font-semibold">{t.plans.exempt}</p>
            <p className="mt-1 text-[15px] text-[#8B909A]">{t.plans.minutesLeft(billing.creditMinutes)}</p>
          </Card>
        ) : hasPlan && sub ? (
          <Card>
            <p className="text-sm text-[#8B909A]">{t.plans.current}</p>
            <div className="mt-1 flex items-center gap-2">
              <p className="text-xl font-bold">{t.plans.names[sub.planCode]}</p>
              <span className="inline-flex h-6 items-center rounded-full bg-accent px-2.5 text-[13px] font-bold text-on-accent">
                {t.plans.status[sub.status]}
              </span>
            </div>
            <p className="mt-3 text-[15px]">{t.plans.minutesLeft(billing.creditMinutes)}</p>
            {sub.currentPeriodEnd ? (
              <p className="mt-1 text-[15px] text-[#8B909A]">
                {sub.cancelAtPeriodEnd ? t.plans.ends(date(sub.currentPeriodEnd)) : t.plans.renews(date(sub.currentPeriodEnd))}
              </p>
            ) : null}
            {sub.status === "past_due" ? <p className="mt-3 text-sm text-red-300">{t.plans.pastDue}</p> : null}
            {billing.portalUrl ? (
              <a
                href={billing.portalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-4 flex h-12 items-center justify-center rounded-2xl border border-line text-[15px] font-semibold"
              >
                {t.plans.manage}
              </a>
            ) : null}
            {billing.portalUrl ? <p className="mt-2 text-center text-xs text-[#8B909A]">{t.plans.manageHint}</p> : null}
          </Card>
        ) : (
          <>
            {billing.checkout ? null : <Alert kind="info">{t.plans.unavailable}</Alert>}
            {billing.trialEligible ? (
              <PlanCard
                name={t.plans.names.trial}
                price={usd(PLANS.trial.priceUsd)}
                period={t.plans.trialPeriod}
                minutes={t.plans.minutes(PLANS.trial.minutes)}
                note={billing.checkout?.options.find((o) => o.plan === "trial")?.discountId ? t.plans.trialThenDiscount : t.plans.trialThen}
                action={billing.checkout ? (opening === "trial" ? t.plans.opening : t.plans.startTrial) : t.plans.soon}
                onAction={() => onBuy("trial")}
                busy={!billing.checkout || opening !== null || activating}
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
                action={billing.checkout ? (opening === plan ? t.plans.opening : t.plans.choose(t.plans.names[plan])) : t.plans.soon}
                onAction={() => onBuy(plan)}
                busy={!billing.checkout || opening !== null || activating}
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
            <p className="px-1 text-sm text-[#8B909A]">{t.plans.noRollover}</p>
          </>
        )}
      </div>
    </div>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <section className="rounded-2xl border border-[#1C2029] bg-[#12151B] px-5 py-5">{children}</section>;
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
    <section className={`rounded-2xl border px-5 py-5 ${props.highlight ? "border-accent/60 bg-accent/[0.06]" : "border-[#1C2029] bg-[#12151B]"}`}>
      <div className="flex items-center gap-2">
        <p className="text-lg font-bold">{props.name}</p>
        {props.badge ? (
          <span className="inline-flex h-6 items-center rounded-full bg-accent px-2.5 text-[12px] font-bold text-on-accent">{props.badge}</span>
        ) : null}
      </div>
      <p className="mt-1">
        <span className="text-[28px] font-extrabold tracking-tight">{props.price}</span>{" "}
        <span className="text-[15px] text-[#8B909A]">{props.period}</span>
      </p>
      <p className="mt-1 text-[15px]">{props.minutes}</p>
      {props.note ? <p className="mt-2 text-sm text-[#8B909A]">{props.note}</p> : null}
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
