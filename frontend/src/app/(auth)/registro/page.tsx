"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { signUp } from "aws-amplify/auth";
import { Alert, AuthCard, Field, NotConfigured, SubmitButton } from "@/components/ui";
import { LEGAL_PATHS } from "@/components/legal-page";
import { useLocale, useT } from "@/i18n/provider";
import { authConfigured } from "@/lib/amplify-config";
import { authErrorMessage } from "@/lib/auth-errors";

export default function RegisterPage() {
  const t = useT();
  const { locale } = useLocale();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (password !== confirm) {
      setError(t.auth.passwordsDontMatch);
      return;
    }
    setLoading(true);
    try {
      const normalized = email.trim().toLowerCase();
      await signUp({ username: normalized, password, options: { userAttributes: { email: normalized } } });
      router.push(`/verificar?email=${encodeURIComponent(normalized)}`);
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthCard title={t.auth.registerTitle} subtitle={t.auth.registerSubtitle}>
      {!authConfigured ? (
        <NotConfigured />
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          <Field label={t.auth.email} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <Field
            label={t.auth.password}
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p className="-mt-2 text-xs text-muted">{t.auth.passwordHint}</p>
          <Field
            label={t.auth.repeatPassword}
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          <Alert kind="error">{error}</Alert>
          <SubmitButton loading={loading}>{t.auth.createAccount}</SubmitButton>
          <p className="text-center text-xs leading-[18px] text-muted">
            {t.auth.acceptPrefix}{" "}
            <Link href={LEGAL_PATHS.terms[locale]} className="text-foreground underline">
              {t.auth.terms}
            </Link>{" "}
            {t.auth.and}{" "}
            <Link href={LEGAL_PATHS.privacy[locale]} className="text-foreground underline">
              {t.auth.privacy}
            </Link>
            .
          </p>
          <p className="text-center text-sm text-muted">
            {t.auth.haveAccount}{" "}
            <Link href="/login" className="text-foreground hover:underline">
              {t.auth.signInLink}
            </Link>
          </p>
        </form>
      )}
    </AuthCard>
  );
}
