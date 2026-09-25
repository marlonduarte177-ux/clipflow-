"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { signUp } from "aws-amplify/auth";
import { Alert, AuthCard, Field, NotConfigured, SubmitButton } from "@/components/ui";
import { authConfigured } from "@/lib/amplify-config";
import { authErrorMessage } from "@/lib/auth-errors";

export default function RegisterPage() {
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
      setError("Las contraseñas no coinciden.");
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
    <AuthCard title="Crea tu cuenta" subtitle="Te enviaremos un código para verificar tu email.">
      {!authConfigured ? (
        <NotConfigured />
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <Field
            label="Contraseña"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p className="-mt-2 text-xs text-muted">Mínimo 10 caracteres, con mayúsculas, minúsculas y números.</p>
          <Field
            label="Repite la contraseña"
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          <Alert kind="error">{error}</Alert>
          <SubmitButton loading={loading}>Crear cuenta</SubmitButton>
          <p className="text-center text-sm text-muted">
            ¿Ya tienes cuenta?{" "}
            <Link href="/login" className="text-foreground hover:underline">
              Inicia sesión
            </Link>
          </p>
        </form>
      )}
    </AuthCard>
  );
}
