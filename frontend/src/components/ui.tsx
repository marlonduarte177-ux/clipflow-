import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

export function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2 text-lg font-semibold tracking-tight">
      <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent text-sm font-bold text-black">
        CF
      </span>
      ClipFlow
    </Link>
  );
}

export function AuthCard({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <main className="flex flex-1 flex-col items-center px-4 py-10 sm:justify-center">
      <div className="mb-8">
        <Logo />
      </div>
      <section className="w-full max-w-sm rounded-2xl border border-line bg-surface p-6 shadow-xl">
        <h1 className="text-xl font-semibold">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
        <div className="mt-6">{children}</div>
      </section>
    </main>
  );
}

export function Field({ label, ...props }: { label: string } & ComponentProps<"input">) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm text-muted">{label}</span>
      <input
        {...props}
        className="w-full rounded-lg border border-line bg-background px-3 py-2.5 text-base outline-none transition focus:border-accent"
      />
    </label>
  );
}

export function SubmitButton({ loading, children }: { loading: boolean; children: ReactNode }) {
  return (
    <button
      type="submit"
      disabled={loading}
      className="w-full rounded-lg bg-accent px-4 py-2.5 font-medium text-black transition hover:brightness-110 disabled:opacity-60"
    >
      {loading ? "Un momento…" : children}
    </button>
  );
}

export function Alert({ kind, children }: { kind: "error" | "info"; children: ReactNode }) {
  if (!children) return null;
  const styles = kind === "error" ? "border-red-500/40 bg-red-500/10 text-red-200" : "border-accent/40 bg-accent/10 text-foreground";
  return (
    <p role={kind === "error" ? "alert" : "status"} className={`rounded-lg border px-3 py-2 text-sm ${styles}`}>
      {children}
    </p>
  );
}

export function NotConfigured() {
  return (
    <Alert kind="error">
      La autenticación todavía no está configurada. Faltan las variables NEXT_PUBLIC_COGNITO_USER_POOL_ID y
      NEXT_PUBLIC_COGNITO_CLIENT_ID (ver .env.example).
    </Alert>
  );
}
