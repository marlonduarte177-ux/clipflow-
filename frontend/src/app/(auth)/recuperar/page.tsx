"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { confirmResetPassword, resetPassword } from "aws-amplify/auth";
import { Alert, AuthCard, Field, NotConfigured, SubmitButton } from "@/components/ui";
import { useT } from "@/i18n/provider";
import { authConfigured } from "@/lib/amplify-config";
import { authErrorMessage } from "@/lib/auth-errors";

export default function RecoverPage() {
  const t = useT();
  const router = useRouter();
  const [step, setStep] = useState<"request" | "confirm">("request");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function onRequest(event: FormEvent) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      await resetPassword({ username: email.trim() });
      setStep("confirm");
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function onConfirm(event: FormEvent) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      await confirmResetPassword({ username: email.trim(), confirmationCode: code.trim(), newPassword: password });
      router.push(`/login?email=${encodeURIComponent(email.trim())}`);
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthCard
      title={t.auth.recoverTitle}
      subtitle={step === "request" ? t.auth.recoverRequest : t.auth.recoverConfirm}
    >
      {!authConfigured ? (
        <NotConfigured />
      ) : step === "request" ? (
        <form onSubmit={onRequest} className="space-y-4">
          <Field label={t.auth.email} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <Alert kind="error">{error}</Alert>
          <SubmitButton loading={loading}>{t.auth.sendCode}</SubmitButton>
          <p className="text-center text-sm text-muted">
            <Link href="/login" className="hover:text-foreground">
              {t.auth.backToLogin}
            </Link>
          </p>
        </form>
      ) : (
        <form onSubmit={onConfirm} className="space-y-4">
          <Field label={t.auth.code} inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} />
          <Field
            label={t.auth.newPassword}
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Alert kind="error">{error}</Alert>
          <SubmitButton loading={loading}>{t.auth.changePassword}</SubmitButton>
        </form>
      )}
    </AuthCard>
  );
}
