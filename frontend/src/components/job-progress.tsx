import type { JobDto } from "@clipflow/shared";

const STAGE_LABELS: Record<NonNullable<JobDto["stage"]>, string> = {
  preparing: "Preparando video",
  analyzing: "Analizando audio y escenas",
  detecting_moments: "Encontrando momentos",
  rendering_clips: "Generando clips",
  finalizing: "Finalizando",
};

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

function elapsed(fromIso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(fromIso).getTime()) / 1000));
  const m = Math.floor(seconds / 60);
  return m > 0 ? `${m} min ${seconds % 60} s` : `${seconds} s`;
}

/** Progreso real guardado por el worker (no se simula). */
export function JobProgress({ job, showHint = false }: { job: JobDto; showHint?: boolean }) {
  const failed = job.status === "failed";
  const active = isActive(job);
  return (
    <div className="space-y-1">
      <div className="flex justify-between gap-2 text-xs">
        <span className={failed ? "text-red-300" : "text-muted"}>{jobLabel(job)}</span>
        {active ? (
          <span className="shrink-0 text-muted">
            {job.progress}% · {elapsed(job.queuedAt)}
          </span>
        ) : job.status === "completed" ? (
          <span className="text-muted">100%</span>
        ) : null}
      </div>
      {active ? (
        <div className="h-1.5 overflow-hidden rounded-full bg-line">
          <div className="h-full bg-accent transition-all" style={{ width: `${Math.max(job.progress, 2)}%` }} />
        </div>
      ) : null}
      {active && showHint ? (
        <p className="text-xs text-muted">
          Puedes cerrar esta página: el video se sigue procesando en la nube y los clips aparecerán aquí.
        </p>
      ) : null}
    </div>
  );
}
