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
      return job.attempts > 0 ? "En cola para reintentar" : "En cola (el procesador tarda unos minutos en arrancar)";
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

/** Progreso real guardado por el worker (no se simula). */
export function JobProgress({ job }: { job: JobDto }) {
  const failed = job.status === "failed";
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className={failed ? "text-red-300" : "text-muted"}>{jobLabel(job)}</span>
        {isActive(job) || job.status === "completed" ? <span className="text-muted">{job.progress}%</span> : null}
      </div>
      {isActive(job) ? (
        <div className="h-1.5 overflow-hidden rounded-full bg-line">
          <div className="h-full bg-accent transition-all" style={{ width: `${job.progress}%` }} />
        </div>
      ) : null}
    </div>
  );
}
