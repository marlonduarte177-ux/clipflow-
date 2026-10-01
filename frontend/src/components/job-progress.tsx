import type { JobDto } from "@clipflow/shared";
import { BellIcon, CheckIcon } from "./icons";

const STAGE_LABELS: Record<NonNullable<JobDto["stage"]>, string> = {
  preparing: "Preparando el video",
  analyzing: "Escuchando y transcribiendo",
  detecting_moments: "Eligiendo los mejores momentos",
  rendering_clips: "Generando clips",
  finalizing: "Últimos detalles",
};
const STAGES = Object.keys(STAGE_LABELS) as NonNullable<JobDto["stage"]>[];

export function jobLabel(job: JobDto): string {
  switch (job.status) {
    case "queued":
      return job.attempts > 0 ? "En cola para reintentar" : "Encendiendo el procesador…";
    case "processing":
      return job.stage ? STAGE_LABELS[job.stage] : "Procesando";
    case "completed":
      return "Terminado";
    case "failed":
      return job.errorMessage ?? "Falló el procesamiento";
    case "cancelled":
      return "Cancelado";
  }
}

export const isActive = (job: JobDto | undefined) => job?.status === "queued" || job?.status === "processing";

const secondsSince = (iso: string) => Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);

function duration(seconds: number): string {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Estimación de lo que falta, a partir del avance real (solo cuando ya hay datos suficientes). */
function remaining(job: JobDto): string | null {
  if (job.status !== "processing" || !job.startedAt || job.progress < 8) return null;
  const left = (secondsSince(job.startedAt) * (100 - job.progress)) / job.progress;
  if (left < 60) return "Falta menos de un minuto";
  return `Faltan unos ${Math.round(left / 60)} min`;
}

/** Barra compacta (listas). Progreso real guardado por el worker: no se simula. */
export function JobProgress({ job }: { job: JobDto }) {
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
        {jobLabel(job)}
        {active ? ` · ${job.progress} %` : ""}
      </p>
    </div>
  );
}

/** Pantalla de progreso: anillo con el porcentaje, tiempos y la lista de pasos. */
export function JobProgressPanel({ job, subtitles }: { job: JobDto; subtitles: boolean }) {
  const radius = 86;
  const circumference = 2 * Math.PI * radius;
  const progress = job.status === "queued" ? 0 : job.progress;
  const current = job.status === "queued" ? -1 : job.stage ? STAGES.indexOf(job.stage) : 0;
  const hint = remaining(job);
  const steps = [
    { label: "Video subido", state: "done" as const },
    ...STAGES.map((stage, i) => ({
      label: stage === "rendering_clips" && subtitles ? "Generando clips con subtítulos" : STAGE_LABELS[stage],
      state: i < current ? ("done" as const) : i === current ? ("active" as const) : ("pending" as const),
    })),
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-col items-center gap-2 pt-2">
        <div className="relative h-[196px] w-[196px]">
          <svg width="196" height="196" viewBox="0 0 196 196" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-label="Avance del procesamiento">
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
            <span className="text-[13px] text-muted">{duration(secondsSince(job.queuedAt))} transcurrido</span>
          </div>
        </div>
        <p className="text-lg font-semibold">{jobLabel(job)}</p>
        <p className="min-h-5 text-sm text-muted">{hint ?? (job.status === "queued" ? "Empieza en unos segundos" : "")}</p>
      </div>

      <ol className="space-y-3.5 rounded-2xl border border-line bg-surface p-4">
        {steps.map((step) => (
          <li key={step.label} className="flex items-center gap-3">
            {step.state === "done" ? (
              <span className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-full bg-accent text-black">
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
          <p className="text-sm font-semibold">Puedes cerrar esta página</p>
          <p className="text-[13px] leading-[18px] text-[#a5ad96]">Seguimos trabajando. Tus clips te esperan en Mis videos cuando vuelvas.</p>
        </div>
      </div>
    </div>
  );
}
