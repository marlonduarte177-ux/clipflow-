"use client";

import { translateMessage, type JobDto, type Locale } from "@clipflow/shared";
import { useLocale, useT } from "@/i18n/provider";
import type { Messages } from "@/i18n/messages";
import { BellIcon, CheckIcon } from "./icons";

const STAGES = ["downloading", "preparing", "analyzing", "detecting_moments", "rendering_clips", "finalizing"] as const satisfies NonNullable<
  JobDto["stage"]
>[];

export function jobLabel(job: JobDto, t: Messages, locale: Locale): string {
  switch (job.status) {
    case "queued":
      return job.attempts > 0 ? t.progress.queuedRetry : t.progress.starting;
    case "processing":
      return job.stage ? t.progress.stages[job.stage] : t.progress.processing;
    case "completed":
      return t.progress.completed;
    case "failed":
      return translateMessage(job.errorMessage, locale) ?? t.progress.failed;
    case "cancelled":
      return t.progress.cancelled;
  }
}

export const isActive = (job: JobDto | undefined) => job?.status === "queued" || job?.status === "processing";

const secondsSince = (iso: string) => Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);

function duration(seconds: number): string {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Estimación de lo que falta, a partir del avance real (solo cuando ya hay datos suficientes). */
function remaining(job: JobDto, t: Messages): string | null {
  if (job.status !== "processing" || !job.startedAt || job.progress < 8) return null;
  const left = (secondsSince(job.startedAt) * (100 - job.progress)) / job.progress;
  if (left < 60) return t.progress.lessThanMinute;
  return t.progress.minutesLeft(Math.round(left / 60));
}

/** Barra compacta (listas). Progreso real guardado por el worker: no se simula. */
export function JobProgress({ job }: { job: JobDto }) {
  const t = useT();
  const { locale } = useLocale();
  const failed = job.status === "failed";
  const active = isActive(job);
  return (
    <div className="space-y-1.5">
      {active ? (
        <div className="h-1.5 overflow-hidden rounded-full bg-line">
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.max(job.progress, 3)}%` }} />
        </div>
      ) : null}
      <p className={`text-xs ${failed ? "text-red-300" : "text-muted"}`}>
        {jobLabel(job, t, locale)}
        {active ? ` · ${job.progress} %` : ""}
      </p>
    </div>
  );
}

/** Pantalla de progreso: anillo con el porcentaje, tiempos y la lista de pasos. */
export function JobProgressPanel({ job, subtitles, imported = false }: { job: JobDto; subtitles: boolean; imported?: boolean }) {
  const t = useT();
  const { locale } = useLocale();
  const downloadOnly = job.params.downloadOnly === true;
  const radius = 86;
  const circumference = 2 * Math.PI * radius;
  const progress = job.status === "queued" ? 0 : job.progress;
  const current = job.status === "queued" ? -1 : job.stage ? (STAGES as readonly string[]).indexOf(job.stage) : 0;
  const hint = remaining(job, t);
  // Por enlace, el primer paso es descargarlo; si se subió un archivo, ese paso ya pasó.
  const stageSteps = STAGES.map((stage, i) => ({
    stage,
    label: stage === "rendering_clips" && subtitles ? t.progress.renderingWithSubtitles : t.progress.stages[stage],
    state: i < current ? ("done" as const) : i === current ? ("active" as const) : ("pending" as const),
  }));
  // "Solo descargar": bajar el video y dejarlo listo; no hay análisis ni clips.
  const steps = downloadOnly
    ? stageSteps
        .filter((s) => s.stage === "downloading" || s.stage === "preparing")
        .map((s) => (s.stage === "preparing" ? { ...s, label: t.progress.preparingDownload } : s))
    : imported
      ? stageSteps
      : [{ label: t.progress.uploaded, state: "done" as const }, ...stageSteps.filter((s) => s.stage !== "downloading")];

  return (
    <div className="space-y-5">
      <div className="flex flex-col items-center gap-2 pt-2">
        <div className="relative h-[196px] w-[196px]">
          <svg width="196" height="196" viewBox="0 0 196 196" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-label={t.progress.ariaProgress}>
            <circle cx="98" cy="98" r={radius} fill="none" stroke="#1d2230" strokeWidth="12" />
            <circle
              cx="98"
              cy="98"
              r={radius}
              fill="none"
              stroke="var(--accent)"
              strokeWidth="12"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - Math.max(progress, 1) / 100)}
              transform="rotate(-90 98 98)"
              className="transition-[stroke-dashoffset] duration-700"
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-[46px] font-bold tracking-tight">{progress}%</span>
            <span className="text-[13px] text-muted">{t.progress.elapsed(duration(secondsSince(job.queuedAt)))}</span>
          </div>
        </div>
        <p className="text-lg font-semibold">{jobLabel(job, t, locale)}</p>
        <p className="min-h-5 text-sm text-muted">{hint ?? (job.status === "queued" ? t.progress.startsSoon : "")}</p>
      </div>

      <ol className="space-y-3.5 rounded-2xl border border-line bg-surface p-4">
        {steps.map((step) => (
          <li key={step.label} className="flex items-center gap-3">
            {step.state === "done" ? (
              <span className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-full bg-accent text-on-accent">
                <CheckIcon size={14} strokeWidth={3} />
              </span>
            ) : step.state === "active" ? (
              <span className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-full border-2 border-accent">
                <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-accent" />
              </span>
            ) : (
              <span className="h-[26px] w-[26px] shrink-0 rounded-full border-2 border-[#2b3140]" />
            )}
            <span className={`text-sm ${step.state === "active" ? "font-semibold" : step.state === "pending" ? "text-muted" : ""}`}>
              {step.label}
            </span>
          </li>
        ))}
      </ol>

      <div className="flex items-start gap-3 rounded-2xl border border-[#2c3a14] bg-[#161b12] px-4 py-3.5">
        <BellIcon size={20} className="mt-0.5 shrink-0 text-accent" />
        <div>
          <p className="text-sm font-semibold">{t.progress.canClose}</p>
          <p className="text-[13px] leading-[18px] text-[#a5ad96]">{t.progress.canCloseText}</p>
        </div>
      </div>
    </div>
  );
}
