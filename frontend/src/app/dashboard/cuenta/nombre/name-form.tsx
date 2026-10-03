"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { updateUserAttributes } from "aws-amplify/auth";
import { BackIcon } from "@/components/icons";
import { Alert } from "@/components/ui";
import { useT } from "@/i18n/provider";

const MAX_NAME = 80;

/** Editar el nombre (atributo "name" del usuario en Cognito). */
export function NameForm({ initial }: { initial: string }) {
  const t = useT();
  const router = useRouter();
  const [name, setName] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const trimmed = name.trim().replace(/\s+/g, " ");

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (trimmed.length > MAX_NAME) {
      setError(t.name.tooLong);
      return;
    }
    setSaving(true);
    setError("");
    try {
      await updateUserAttributes({ userAttributes: { name: trimmed } });
      router.push("/dashboard/cuenta");
      router.refresh();
    } catch {
      setError(t.name.failed);
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl">
      <Link href="/dashboard/cuenta" className="inline-flex items-center gap-1 text-sm text-muted hover:text-foreground">
        <BackIcon size={18} />
        {t.account.title}
      </Link>
      <h1 className="mt-4 text-[28px] font-extrabold tracking-tight">{t.name.title}</h1>
      <form onSubmit={onSubmit} className="mt-5 space-y-4">
        <label className="block space-y-1.5">
          <span className="text-sm text-muted">{t.name.label}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={MAX_NAME}
            autoComplete="name"
            autoFocus
            className="h-12 w-full rounded-2xl border border-[#1C2029] bg-[#12151B] px-4 text-base text-[#F3F4F6] outline-none focus:border-accent"
          />
          <span className="block text-xs text-muted">{t.name.hint}</span>
        </label>
        <Alert kind="error">{error}</Alert>
        <button
          type="submit"
          disabled={saving || !trimmed || trimmed === initial}
          className="h-12 w-full rounded-2xl bg-accent text-[15px] font-bold text-on-accent disabled:opacity-40"
        >
          {saving ? t.common.saving : t.common.save}
        </button>
      </form>
    </div>
  );
}
