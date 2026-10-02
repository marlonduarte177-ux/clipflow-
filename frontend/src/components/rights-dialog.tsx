"use client";

import { useEffect, useId } from "react";

/**
 * Ventana de aviso de derechos de autor antes de importar un video por enlace.
 * Tocar "Acepto, importar" es la confirmación; la API la vuelve a exigir y guarda cuándo se dio.
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
  const titleId = useId();
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
          (TikTok, Instagram, Facebook…).
        </p>
        <ul className="list-disc space-y-1.5 pl-5 text-[13px] leading-[18px] text-muted">
          <li>Eres responsable del contenido que importas y de cómo usas los clips.</li>
          <li>Guardamos el enlace y la fecha de esta confirmación.</li>
          <li>Si el video es privado o la plataforma bloquea la descarga, te avisaremos para que lo subas como archivo.</li>
        </ul>

        <p className="rounded-2xl border border-line bg-background p-3.5 text-[13px] leading-[18px]">
          Al tocar <strong>“Acepto, importar”</strong> confirmas que el video es tuyo o que tienes permiso de quien tiene los
          derechos para usarlo.
        </p>

        <div className="grid grid-cols-2 gap-2.5 pt-1">
          <button type="button" onClick={onCancel} disabled={busy} className="h-12 rounded-2xl border border-line text-[15px] font-semibold disabled:opacity-50">
            Cancelar
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="h-12 rounded-2xl bg-accent text-[15px] font-bold text-black disabled:opacity-40"
          >
            {busy ? "Importando…" : "Acepto, importar"}
          </button>
        </div>
      </div>
    </div>
  );
}
