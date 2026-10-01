"use client";

import { useEffect, useId, useState } from "react";

/**
 * Ventana de aviso de derechos de autor antes de importar un video por enlace.
 * No se puede continuar sin marcar la casilla; la API vuelve a exigir la confirmación y guarda
 * cuándo se dio.
 */
export function RightsDialog({
  url,
  busy,
  onCancel,
  onConfirm,
}: {
  url: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [checked, setChecked] = useState(false);
  const titleId = useId();
  const checkId = useId();
  let host = url;
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    // Se muestra tal cual; la API lo valida.
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center sm:p-6">
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="w-full max-w-md space-y-4 rounded-t-[28px] border border-line bg-surface px-5 pb-[max(20px,env(safe-area-inset-bottom))] pt-6 sm:rounded-[28px]">
        <div className="space-y-1">
          <h2 id={titleId} className="text-xl font-bold tracking-tight">
            Antes de importar
          </h2>
          <p className="truncate text-sm text-muted">Video de {host}</p>
        </div>

        <p className="text-sm leading-5">
          Importa solo videos que sean tuyos o que tengas permiso de usar. Descargar o reutilizar contenido de otras personas
          sin autorización puede infringir sus <strong>derechos de autor</strong> y las reglas de la plataforma de origen
          (YouTube, TikTok, Instagram…).
        </p>
        <ul className="list-disc space-y-1.5 pl-5 text-[13px] leading-[18px] text-muted">
          <li>Eres responsable del contenido que importas y de cómo usas los clips.</li>
          <li>Guardamos el enlace y la fecha de esta confirmación.</li>
          <li>Si el video es privado o la plataforma bloquea la descarga, te avisaremos para que lo subas como archivo.</li>
        </ul>

        <label htmlFor={checkId} className="flex cursor-pointer items-start gap-3 rounded-2xl border border-line bg-background p-3.5">
          <input
            id={checkId}
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--accent)]"
          />
          <span className="text-sm leading-5">Confirmo que el video es mío o que tengo permiso de quien tiene los derechos para usarlo.</span>
        </label>

        <div className="grid grid-cols-2 gap-2.5 pt-1">
          <button type="button" onClick={onCancel} disabled={busy} className="h-12 rounded-2xl border border-line text-[15px] font-semibold disabled:opacity-50">
            Cancelar
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!checked || busy}
            className="h-12 rounded-2xl bg-accent text-[15px] font-bold text-black disabled:opacity-40"
          >
            {busy ? "Importando…" : "Importar video"}
          </button>
        </div>
      </div>
    </div>
  );
}
