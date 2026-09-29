"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { confirmSignUp, resendSignUpCode } from "aws-amplify/auth";
import { Alert, Field, NotConfigured, SubmitButton } from "@/components/ui";
import { authConfigured } from "@/lib/amplify-config";
import { authErrorMessage } from "@/lib/auth-errors";

export function VerifyForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [loading, setLoading] = useState(false);

  if (!authConfigured) return <NotConfigured />;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setInfo("");
    setLoading(true);
    try {
      await confirmSignUp({ username: email.trim(), confirmationCode: code.trim() });
      router.push(`/login?email=${encodeURIComponent(email.trim())}&verificado=1`);
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function onResend() {
    setError("");
    setInfo("");
    try {
      await resendSignUpCode({ username: email.trim() });
      setInfo("Te enviamos un código nuevo. Revisa también la carpeta de spam.");
    } catch (err) {
      setError(authErrorMessage(err));
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Field label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      <Field
        label="Código"
        inputMode="numeric"
        autoComplete="one-time-code"
        required
        value={code}
        onChange={(e) => setCode(e.target.value)}
      />
      <Alert kind="error">{error}</Alert>
      <Alert kind="info">{info}</Alert>
      <SubmitButton loading={loading}>Verificar</SubmitButton>
      <button type="button" onClick={onResend} disabled={!email} className="w-full text-sm text-muted hover:text-foreground disabled:opacity-50">
        Reenviar código
      </button>
    </form>
  );
}
