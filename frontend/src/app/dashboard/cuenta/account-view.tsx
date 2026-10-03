"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState, type ReactNode } from "react";
import { deleteUser, signOut } from "aws-amplify/auth";
import type { MeResponse } from "@clipflow/shared";
import { apiFetch, ApiError } from "@/lib/api";
import {
  BoltIcon,
  BulbIcon,
  CrownIcon,
  DocumentIcon,
  GlobeIcon,
  HelpIcon,
  LinkIcon,
  LogoutIcon,
  MailIcon,
  NextIcon,
  ShieldIcon,
  TrashIcon,
  UserIcon,
} from "@/components/icons";

/** Página "Próximamente" para lo que todavía no tiene función. */
const soon = (que: string) => `/dashboard/proximamente?que=${encodeURIComponent(que)}`;

export function AccountView({ name, email }: { name: string | null; email: string }) {
  const router = useRouter();
  const [credits, setCredits] = useState<number | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch<MeResponse>("/me", { signal: controller.signal })
      .then((me) => setCredits(me.creditMinutes ?? 0))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  async function onSignOut() {
    setLeaving(true);
    try {
      await signOut();
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }

  return (
    <div className="mx-auto max-w-xl">
      <h1 className="text-[28px] font-extrabold tracking-tight">Cuenta</h1>
      <div className="mt-5 space-y-5">
        <Group>
          <Row icon={<UserIcon size={20} />} label="Nombre" value={name ?? "Sin nombre"} />
          <Row icon={<MailIcon size={20} />} label="Correo" value={email} />
          <Row
            icon={<CrownIcon size={20} />}
            label="Suscripción"
            href={soon("Planes")}
            value={
              <span className="flex items-center gap-2">
                Gratis
                <span className="inline-flex h-6 items-center rounded-full bg-accent px-2.5 text-[13px] font-bold text-on-accent">Mejorar</span>
              </span>
            }
          />
          <Row icon={<BoltIcon size={20} />} label="Créditos" href={soon("Créditos")} value={credits === null ? "…" : `${credits} min`} />
        </Group>

        <Group>
          <Row icon={<LinkIcon size={20} />} label="Redes conectadas" href={soon("Redes conectadas")} />
        </Group>

        <Group>
          <Row icon={<GlobeIcon size={20} />} label="Idioma" value="Español" href={soon("Idioma")} />
          <Row icon={<HelpIcon size={20} />} label="Ayuda y soporte" href={soon("Ayuda y soporte")} />
          <Row icon={<BulbIcon size={20} />} label="Sugerir una función" href={soon("Sugerir una función")} />
        </Group>

        <Group>
          <Row icon={<ShieldIcon size={20} />} label="Política de privacidad" href={soon("Política de privacidad")} />
          <Row icon={<DocumentIcon size={20} />} label="Términos de uso" href={soon("Términos de uso")} />
        </Group>

        <Group>
          <Row icon={<LogoutIcon size={20} />} label={leaving ? "Saliendo…" : "Cerrar sesión"} onClick={leaving ? undefined : onSignOut} />
        </Group>

        <Group>
          <Row icon={<TrashIcon size={20} />} label="Eliminar cuenta" danger onClick={() => setConfirmDelete(true)} />
        </Group>
      </div>

      {confirmDelete ? <DeleteAccountDialog onCancel={() => setConfirmDelete(false)} /> : null}
    </div>
  );
}

function Group({ children }: { children: ReactNode }) {
  return <section className="overflow-hidden rounded-2xl border border-[#1C2029] bg-[#12151B]">{children}</section>;
}

/**
 * Fila de la cuenta: ícono, texto, valor a la derecha y flecha si lleva a algún lado.
 * El separador empieza después del ícono (16 px de margen + 20 px de ícono + 12 px de espacio).
 */
function Row({
  icon,
  label,
  value,
  href,
  onClick,
  danger = false,
}: {
  icon: ReactNode;
  label: string;
  value?: ReactNode;
  href?: string;
  onClick?: () => void;
  danger?: boolean;
}) {
  const interactive = Boolean(href || onClick);
  const inner = (
    <>
      <span className={`shrink-0 ${danger ? "text-[#FF5C5C]" : "text-[#C9CDD4]"}`}>{icon}</span>
      <span className="flex h-12 min-w-0 flex-1 items-center gap-3 border-b border-[#1C2029] pr-4 group-last:border-b-0">
        <span className={`shrink-0 text-base ${danger ? "text-[#FF5C5C]" : "text-[#F3F4F6]"}`}>{label}</span>
        {value !== undefined ? (
          <span className="ml-auto min-w-0 truncate text-right text-[15px] text-[#8B909A]">{value}</span>
        ) : (
          <span className="ml-auto" />
        )}
        {interactive ? <NextIcon size={16} className="shrink-0 text-[#5F6570]" /> : null}
      </span>
    </>
  );
  const className = `group flex w-full items-center gap-3 pl-4 text-left ${interactive ? "transition hover:bg-white/[0.03] active:bg-white/[0.05]" : ""}`;
  if (href) {
    return (
      <Link href={href} className={className}>
        {inner}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={className}>
        {inner}
      </button>
    );
  }
  return <div className={className}>{inner}</div>;
}

/** Confirmación para eliminar la cuenta: hay que escribir ELIMINAR. */
function DeleteAccountDialog({ onCancel }: { onCancel: () => void }) {
  const router = useRouter();
  const titleId = useId();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = text.trim().toUpperCase() === "ELIMINAR";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  async function onConfirm() {
    setBusy(true);
    setError(null);
    try {
      // 1) Se borran los videos, clips y archivos. 2) Se borra el usuario de inicio de sesión.
      await apiFetch<void>("/me", { method: "DELETE" });
      try {
        await deleteUser();
      } catch {
        // Los datos ya se borraron; si el login no se pudo borrar, al menos se cierra la sesión.
        await signOut().catch(() => undefined);
      }
      router.replace("/login");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo eliminar la cuenta. Intenta de nuevo.");
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center sm:p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-md space-y-4 rounded-t-[28px] border border-line bg-surface px-5 pb-[max(20px,env(safe-area-inset-bottom))] pt-6 sm:rounded-[28px]"
      >
        <h2 id={titleId} className="text-xl font-bold">
          ¿Eliminar tu cuenta?
        </h2>
        <p className="text-[15px] leading-[22px] text-muted">
          Se borrarán para siempre todos tus videos, clips, transcripciones y proyectos. No se puede deshacer.
        </p>
        <label className="block">
          <span className="mb-1.5 block text-sm text-muted">
            Escribe <strong className="text-foreground">ELIMINAR</strong> para confirmar
          </span>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoCapitalize="characters"
            autoComplete="off"
            className="h-12 w-full rounded-xl border border-line bg-background px-3 text-base outline-none focus:border-[#FF5C5C]"
          />
        </label>
        {error ? <p className="text-sm text-[#FF5C5C]">{error}</p> : null}
        <div className="grid grid-cols-2 gap-3">
          <button type="button" onClick={onCancel} disabled={busy} className="h-12 rounded-2xl border border-line text-[15px] font-semibold disabled:opacity-40">
            Cancelar
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!ready || busy}
            className="h-12 rounded-2xl bg-[#FF5C5C] text-[15px] font-bold text-[#0A0C10] disabled:opacity-40"
          >
            {busy ? "Eliminando…" : "Eliminar cuenta"}
          </button>
        </div>
      </div>
    </div>
  );
}
