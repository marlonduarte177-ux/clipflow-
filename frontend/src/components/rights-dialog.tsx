"use client";

import { useEffect, useId } from "react";
import { useT } from "@/i18n/provider";

/**
 * Ventana de aviso de derechos de autor antes de importar un video por enlace.
 * Tocar "Acepto, importar" (o "Acepto, descargar") es la confirmación; la API la vuelve a exigir y
 * guarda cuándo se dio.
 */
export function RightsDialog({
  url,
  busy,
  action = "importar",
  onCancel,
  onConfirm,
}: {
  url: string;
  busy: boolean;
  action?: "importar" | "descargar";
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const accept = action === "descargar" ? t.rights.acceptDownload : t.rights.acceptImport;
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
            {t.rights.title}
          </h2>
          <p className="truncate text-sm text-muted">{t.rights.from(host)}</p>
        </div>

        <p className="text-sm leading-5">
          {t.rights.body1} <strong>{t.rights.copyright}</strong> {t.rights.body2}
        </p>
        <ul className="list-disc space-y-1.5 pl-5 text-[13px] leading-[18px] text-muted">
          <li>{t.rights.point1}</li>
          <li>{t.rights.point2}</li>
          <li>{t.rights.point3}</li>
        </ul>

        <p className="rounded-2xl border border-line bg-background p-3.5 text-[13px] leading-[18px]">
          {t.rights.confirmPrefix} <strong>“{accept}”</strong> {t.rights.confirmSuffix}
        </p>

        <div className="grid grid-cols-2 gap-2.5 pt-1">
          <button type="button" onClick={onCancel} disabled={busy} className="h-12 rounded-2xl border border-line text-[15px] font-semibold disabled:opacity-50">
            {t.common.cancel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="h-12 rounded-2xl bg-accent text-[15px] font-bold text-on-accent disabled:opacity-40"
          >
            {busy ? (action === "descargar" ? t.rights.downloading : t.rights.importing) : accept}
          </button>
        </div>
      </div>
    </div>
  );
}
