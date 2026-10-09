"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { BackIcon } from "@/components/icons";
import { Alert } from "@/components/ui";
import { errorMessage } from "@/i18n/locale";
import { useT } from "@/i18n/provider";
import { apiConfigured, apiFetch, formatDuration } from "@/lib/api";

interface Clip {
  id: string;
  title: string | null;
  startSeconds: number;
  endSeconds: number;
  score: number | null;
  reason: string | null;
  thumbnailUrl: string | null;
  videoUrl: string | null;
}
interface Variant {
  pipeline: "classic" | "v2";
  videoId: string;
  status: string;
  progress: number;
  errorMessage: string | null;
  clipCount: number | null;
  ai: string | null;
  aiReason: string | null;
  models: { transcription?: string; analysis?: string } | null;
  sounds: Record<string, number> | null;
  analysisFrames: number | null;
  processingSeconds: number | null;
  costs: { transcriptionUsd: number; textUsd: number; visionUsd: number; computeUsd: number; totalUsd: number } | null;
  perHour: { transcriptionUsd: number | null; analysisUsd: number | null; computeUsd: number | null; totalUsd: number | null } | null;
  clips: Clip[];
}
interface Comparison {
  comparisonId: string;
  createdAt: string;
  video: string;
  durationSeconds: number | null;
  variants: Variant[];
}

const usd = (n: number | null | undefined) => (n == null ? "—" : `$${n.toFixed(n < 1 ? 3 : 2)}`);

/** Herramienta interna (solo el dueño): la versión actual y la nueva, con sus clips y su costo real, lado a lado. */
export function CompareView() {
  const t = useT();
  const [data, setData] = useState<Comparison[] | null>(null);
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState<string | null>(null);
  const active = data?.some((c) => c.variants.some((v) => v.status === "queued" || v.status === "processing")) ?? false;

  useEffect(() => {
    if (!apiConfigured) return;
    let alive = true;
    const load = () =>
      apiFetch<{ comparisons: Comparison[] }>("/admin/comparisons")
        .then((r) => alive && (setData(r.comparisons), setError("")))
        .catch((err) => alive && setError(errorMessage(err)));
    void load();
    const timer = active ? setInterval(load, 10_000) : undefined;
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [active]);

  return (
    <div className="space-y-5">
      <Link href="/dashboard" className="inline-flex items-center gap-1 text-sm text-muted hover:text-foreground">
        <BackIcon size={18} />
        {t.nav.videos}
      </Link>
      <h1 className="text-[28px] font-extrabold tracking-tight">{t.compare.title}</h1>
      <Alert kind="error">{error}</Alert>
      {data === null && !error ? <p className="text-sm text-muted">{t.common.loading}</p> : null}
      {data?.length === 0 ? <p className="text-sm text-muted">{t.compare.empty}</p> : null}
      {data?.map((c) => (
        <section key={c.comparisonId} className="space-y-3">
          <div>
            <h2 className="truncate text-lg font-bold">{c.video}</h2>
            <p className="text-xs text-muted">
              {new Date(c.createdAt).toLocaleString()}
              {c.durationSeconds ? ` · ${formatDuration(c.durationSeconds)}` : ""}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2.5 sm:gap-4">
            {c.variants.map((v) => (
              <article key={v.pipeline} className="min-w-0 space-y-3 rounded-2xl border border-line bg-surface p-3 sm:p-4">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="font-bold">{v.pipeline === "v2" ? t.compare.v2 : t.compare.classic}</h3>
                  <Link href={`/dashboard/videos/${v.videoId}`} className="shrink-0 text-xs text-accent underline">
                    {t.compare.openVideo}
                  </Link>
                </div>
                {v.models?.analysis ? <p className="truncate text-[11px] text-muted">{v.models.analysis}</p> : null}
                {v.status === "completed" ? (
                  <>
                    <div className="rounded-xl bg-background p-2.5">
                      <p className="text-xl font-extrabold sm:text-2xl">{usd(v.perHour?.totalUsd)}</p>
                      <p className="text-[11px] leading-4 text-muted">{t.compare.perHour}</p>
                    </div>
                    <dl className="grid grid-cols-[1fr_auto] gap-x-2 gap-y-1 text-[12px]">
                      <dt className="text-muted">{t.compare.transcription}</dt>
                      <dd className="text-right">{usd(v.perHour?.transcriptionUsd)}</dd>
                      <dt className="text-muted">{t.compare.analysis}</dt>
                      <dd className="text-right">{usd(v.perHour?.analysisUsd)}</dd>
                      <dt className="text-muted">{t.compare.compute}</dt>
                      <dd className="text-right">{usd(v.perHour?.computeUsd)}</dd>
                      {v.processingSeconds != null ? (
                        <>
                          <dt className="text-muted">{t.compare.time}</dt>
                          <dd className="text-right">{formatDuration(v.processingSeconds)}</dd>
                        </>
                      ) : null}
                    </dl>
                    {v.pipeline === "v2" ? (
                      <p className="text-[11px] leading-4 text-muted">
                        {t.compare.sounds}:{" "}
                        {v.sounds && Object.keys(v.sounds).length
                          ? Object.entries(v.sounds)
                              .map(([k, n]) => `${n} ${t.compare.soundNames[k] ?? k}`)
                              .join(", ")
                          : "0"}
                        {v.analysisFrames != null ? ` · ${t.compare.frames(v.analysisFrames)}` : ""}
                      </p>
                    ) : null}
                    {v.aiReason ? (
                      <p className="rounded-lg border border-yellow-500/40 px-2 py-1 text-[11px] text-yellow-200">{v.aiReason}</p>
                    ) : null}
                    <p className="text-sm font-semibold">{t.compare.clips(v.clipCount ?? 0)}</p>
                    {v.clips.length === 0 ? <p className="text-xs text-muted">{t.compare.noClips}</p> : null}
                    <ol className="space-y-3">
                      {v.clips.map((clip) => (
                        <li key={clip.id} className="space-y-1">
                          <div className="relative aspect-[9/16] w-full overflow-hidden rounded-xl bg-[#1d2433]">
                            {playing === clip.id && clip.videoUrl ? (
                              <video src={clip.videoUrl} controls autoPlay playsInline className="h-full w-full object-cover" />
                            ) : (
                              <button onClick={() => setPlaying(clip.id)} className="block h-full w-full" aria-label={clip.title ?? ""}>
                                {clip.thumbnailUrl ? (
                                  // eslint-disable-next-line @next/next/no-img-element -- URL firmada de S3 que caduca
                                  <img src={clip.thumbnailUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
                                ) : null}
                                <span className="absolute inset-0 m-auto grid h-11 w-11 place-items-center rounded-full bg-black/60 text-lg">▶</span>
                              </button>
                            )}
                            {clip.score != null ? (
                              <span className="pointer-events-none absolute left-2 top-2 rounded-full bg-accent px-2 py-0.5 text-[11px] font-bold text-on-accent">
                                {Math.round(clip.score * 100)}
                              </span>
                            ) : null}
                          </div>
                          <p className="line-clamp-2 text-[13px] font-semibold leading-4">{clip.title ?? "—"}</p>
                          <p className="text-[11px] text-muted">
                            {formatDuration(clip.startSeconds)}–{formatDuration(clip.endSeconds)} · {Math.round(clip.endSeconds - clip.startSeconds)} s
                          </p>
                          {clip.reason ? <p className="line-clamp-3 text-[11px] leading-4 text-[#a3aabb]">{clip.reason}</p> : null}
                        </li>
                      ))}
                    </ol>
                  </>
                ) : (
                  <p className="text-sm text-muted">
                    {v.status === "failed" || v.status === "cancelled"
                      ? (v.errorMessage ?? v.status)
                      : v.status === "queued"
                        ? t.compare.queued
                        : `${t.compare.waiting} ${v.progress}%`}
                  </p>
                )}
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
