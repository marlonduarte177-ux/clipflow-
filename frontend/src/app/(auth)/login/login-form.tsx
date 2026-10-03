"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { signIn, signOut } from "aws-amplify/auth";
import { Alert, Field, NotConfigured, SubmitButton } from "@/components/ui";
import { useT } from "@/i18n/provider";
import { authConfigured } from "@/lib/amplify-config";
import { authErrorMessage, authErrorName } from "@/lib/auth-errors";
import { safeNextPath } from "@/lib/redirect";

export function LoginForm() {
  const t = useT();
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNextPath(params.get("next"));
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  if (!authConfigured) return <NotConfigured />;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      let result;
      try {
        result = await signIn({ username: email.trim(), password });
      } catch (err) {
        // Si quedó una sesión vieja en este navegador, se cierra y se reintenta una vez.
        if (authErrorName(err) !== "UserAlreadyAuthenticatedException") throw err;
        await signOut();
        result = await signIn({ username: email.trim(), password });
      }
      if (result.nextStep.signInStep === "CONFIRM_SIGN_UP") {
        router.push(`/verificar?email=${encodeURIComponent(email.trim())}`);
        return;
      }
      if (result.isSignedIn) {
        router.replace(next);
        router.refresh();
        return;
      }
      setError(t.auth.unsupportedStep);
    } catch (err) {
      if (authErrorName(err) === "UserNotConfirmedException") {
        router.push(`/verificar?email=${encodeURIComponent(email.trim())}`);
        return;
      }
      setError(authErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Field label={t.auth.email} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      <Field
        label={t.auth.password}
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {params.get("verificado") ? <Alert kind="info">{t.auth.verified}</Alert> : null}
      <Alert kind="error">{error}</Alert>
      <SubmitButton loading={loading}>{t.auth.signIn}</SubmitButton>
      <div className="flex justify-between text-sm text-muted">
        <Link href="/recuperar" className="hover:text-foreground">
          {t.auth.forgot}
        </Link>
        <Link href="/registro" className="hover:text-foreground">
          {t.auth.createAccount}
        </Link>
      </div>
    </form>
  );
}
