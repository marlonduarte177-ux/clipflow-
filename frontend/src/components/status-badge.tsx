"use client";

import type { VideoStatus } from "@clipflow/shared";
import { useT } from "@/i18n/provider";

const STYLES: Record<VideoStatus, string> = {
  pending_upload: "border-yellow-500/40 text-yellow-200",
  importing: "border-accent/40 text-accent",
  uploaded: "border-accent/40 text-accent",
  ready: "border-accent/40 text-accent",
  rejected: "border-red-500/40 text-red-300",
  deleted: "border-line text-muted",
};

export function VideoStatusBadge({ status }: { status: VideoStatus }) {
  const t = useT();
  return <span className={`rounded-full border px-2 py-0.5 text-xs ${STYLES[status]}`}>{t.status[status]}</span>;
}
