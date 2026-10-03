import type { VideoStatus } from "@clipflow/shared";

const LABELS: Record<VideoStatus, { text: string; className: string }> = {
  pending_upload: { text: "Subida sin terminar", className: "border-yellow-500/40 text-yellow-200" },
  importing: { text: "Importando", className: "border-accent/40 text-accent" },
  uploaded: { text: "Subido", className: "border-accent/40 text-accent" },
  ready: { text: "Listo", className: "border-accent/40 text-accent" },
  rejected: { text: "Rechazado", className: "border-red-500/40 text-red-300" },
  deleted: { text: "Eliminado", className: "border-line text-muted" },
};

export function VideoStatusBadge({ status }: { status: VideoStatus }) {
  const label = LABELS[status];
  return <span className={`rounded-full border px-2 py-0.5 text-xs ${label.className}`}>{label.text}</span>;
}
