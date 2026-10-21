"use client";

import { useEffect, useState } from "react";
import { translateMessage, type ClipDto, type JobDto } from "@clipflow/shared";
import { BackIcon, CheckIcon, NextIcon, ScissorsIcon, ViralIcon } from "./icons";
import { useLocale, useT } from "@/i18n/provider";
import { clock } from "@/lib/vtt";

/**
 * «¿Cómo quieres editarlo?» (editor de clips, por ahora solo administradores): modo viral automático
 * (recomendado) o editar a mano, aplicar a todos los clips del video y, abajo, «Hacerlo viral».
 */
export function EditModeSheet({
  clip,
  index,
  total,
  editableCount,
  title,
  score,
  busy,
  onBack,
  onStart,
}: {
  clip: ClipDto;
  index: number;
  total: number;
  /** Clips del video que se pueden editar (para «Aplicar a los N clips»). */
  editableCount: number;
  title: string;
  score: number | null;
  busy: boolean;
  onBack: () => void;
  onStart: (options: { applyAll: boolean; music: boolean; hd: boolean }) => void;
}) {
  const t = useT();
  const [applyAll, setApplyAll] = useState(editableCount > 1);
  const [music, setMusic] = useState(true);
  const [hd, setHd] = useState(true);
  const seconds = Math.round(clip.endSeconds - clip.startSeconds);

  // Mientras está abierta, la página de atrás no se mueve; Esc vuelve.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onBack();
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [onBack]);

  return (
    <div role="dialog" aria-modal="true" aria-label={t.editor.title} className="fixed inset-0 z-[60] flex justify-center bg-black/80 sm:items-center sm:p-6">
      <div className="flex h-full w-full max-w-[440px] flex-col overflow-y-auto bg-background sm:h-auto sm:max-h-full sm:rounded-[28px] sm:border sm:border-line">
        <div className="flex items-center gap-3 px-5 pb-3 pt-[max(env(safe-area-inset-top),20px)]">
          <button
            type="button"
            onClick={onBack}
            aria-label={t.editor.watch}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-line bg-surface"
          >
            <BackIcon size={20} />
          </button>
          <div className="min-w-0">
            <h2 className="text-lg font-bold">{t.editor.title}</h2>
            <p className="text-[13px] text-muted">{t.editor.meta(index + 1, total, seconds)}</p>
          </div>
        </div>

        <div className="flex items-center gap-3.5 px-5 pb-5 pt-2">
          <span className="relative block h-[150px] w-[84px] shrink-0 overflow-hidden rounded-xl bg-[#2a3038]">
            {clip.thumbnailUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- URL firmada de S3 que caduca
              <img src={clip.thumbnailUrl} alt="" className="h-full w-full object-cover" />
            ) : null}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <p className="line-clamp-3 text-base font-bold leading-[1.3]">{title}</p>
            <p className="text-[13px] text-muted">{t.editor.fromVideo(clock(clip.startSeconds), clock(clip.endSeconds))}</p>
            {score != null ? (
              <span className="self-start rounded-full bg-[#2a1408] px-2.5 py-1 text-xs font-bold text-[#ff7a45]">{t.editor.viralScore(score)}</span>
            ) : null}
          </div>
        </div>

        <p className="px-5 text-[13px] font-semibold tracking-[0.04em] text-muted">{t.editor.question}</p>

        <div className="flex flex-col gap-3 px-5 py-3">
          {/* Modo viral: la opción elegida (la única activa por ahora). */}
          <div className="flex flex-col gap-3 rounded-[18px] border-2 border-accent bg-[#1a110c] p-[18px]" aria-current="true">
            <div className="flex items-center gap-3">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent text-on-accent">
                <ViralIcon size={22} strokeWidth={2.2} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[17px] font-extrabold">{t.editor.viral}</span>
                <span className="text-xs font-semibold text-[#ff7a45]">{t.editor.recommended}</span>
              </span>
              <span className="grid h-[22px] w-[22px] place-items-center rounded-full bg-accent text-on-accent">
                <CheckIcon size={14} strokeWidth={3} />
              </span>
            </div>
            <p className="text-sm leading-[1.45] text-[#c9cdd4]">{t.editor.viralText}</p>
            <div className="flex flex-wrap gap-1.5">
              {t.editor.chips.map((chip) => (
                <span key={chip} className="rounded-full bg-line px-2.5 py-1 text-xs">
                  {chip}
                </span>
              ))}
            </div>
          </div>

          {/* Editar a mano: llega en la siguiente fase. */}
          <div className="flex items-center gap-3 rounded-[18px] border border-line bg-surface p-[18px] opacity-70" aria-disabled="true">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-line">
              <ScissorsIcon size={22} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[17px] font-bold">{t.editor.manual}</span>
              <span className="text-[13px] leading-[1.4] text-muted">{t.editor.manualText}</span>
            </span>
            <span className="rounded-full border border-line px-2 py-0.5 text-[11px] font-semibold text-muted">{t.editor.soon}</span>
            <NextIcon size={18} className="text-muted" />
          </div>
        </div>

        <div className="flex flex-col gap-2 px-5">
          {editableCount > 1 ? (
            <label className="flex min-h-[52px] items-center gap-3 rounded-[14px] border border-line bg-surface px-4 text-sm">
              <input type="checkbox" checked={applyAll} onChange={(e) => setApplyAll(e.target.checked)} className="h-5 w-5 accent-[#ff5a1f]" />
              <span className="flex-1">{t.editor.applyAll(editableCount)}</span>
            </label>
          ) : null}
          <label className="flex min-h-[52px] items-center gap-3 rounded-[14px] border border-line bg-surface px-4 text-sm">
            <input type="checkbox" checked={music} onChange={(e) => setMusic(e.target.checked)} className="h-5 w-5 accent-[#ff5a1f]" />
            <span className="flex-1">{t.editor.music}</span>
          </label>
          <label className="flex min-h-[52px] items-center gap-3 rounded-[14px] border border-line bg-surface px-4 text-sm">
            <input type="checkbox" checked={hd} onChange={(e) => setHd(e.target.checked)} className="h-5 w-5 accent-[#ff5a1f]" />
            <span className="flex-1">{t.editor.hd}</span>
            <span className="rounded-md bg-accent px-1.5 py-0.5 text-[11px] font-extrabold text-on-accent">HD</span>
          </label>
        </div>

        <div className="flex-1" />

        <div className="mt-5 flex flex-col gap-2.5 border-t border-[#1a1d24] px-5 pb-[max(env(safe-area-inset-bottom),28px)] pt-4">
          <button
            type="button"
            onClick={() => onStart({ applyAll: applyAll && editableCount > 1, music, hd })}
            disabled={busy}
            className="flex h-14 items-center justify-center gap-2 rounded-2xl bg-accent text-[17px] font-extrabold text-on-accent transition active:scale-[0.99] disabled:opacity-60"
          >
            <ViralIcon size={20} strokeWidth={2.4} />
            {busy ? t.common.oneMoment : t.editor.go}
          </button>
          <p className="text-center text-xs text-muted">{t.editor.goHint}</p>
        </div>
      </div>
    </div>
  );
}

/** Barra de avance de una edición en curso (o cómo terminó). */
export function EditProgress({ job }: { job: JobDto }) {
  const t = useT();
  const { locale } = useLocale();
  const count = job.params.clipIds?.length ?? 1;
  if (job.status === "failed") {
    return (
      <div className="rounded-2xl border border-red-400/30 bg-red-500/10 p-4 text-sm">
        <p className="font-semibold text-red-200">{t.editor.failed}</p>
        {job.errorMessage ? <p className="mt-1 text-red-200/80">{translateMessage(job.errorMessage, locale)}</p> : null}
      </div>
    );
  }
  if (job.status === "completed" || job.status === "cancelled") return null;
  return (
    <div className="space-y-2 rounded-2xl border border-accent/40 bg-[#1a110c] p-4" aria-live="polite">
      <div className="flex items-center justify-between gap-3 text-sm font-semibold">
        <span className="flex items-center gap-2">
          <ViralIcon size={16} className="text-accent" />
          {t.editor.working(count)}
        </span>
        <span className="tabular-nums text-muted">{job.progress} %</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.progress}>
        <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${Math.max(4, job.progress)}%` }} />
      </div>
    </div>
  );
}
