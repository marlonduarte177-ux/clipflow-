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
  pipeline: string;
  label: string;
  videoId: string;
  status: string;
  progress: number;
  errorMessage: string | null;
  durationSeconds: number | null;
  clipCount: number | null;
  providers: { transcription?: string; analysis?: string; fallbackReason?: string } | null;
  ai: string | null;
  aiReason: string | null;
  costs: { transcriptionUsd: number; textUsd: number; visionUsd: number; computeUsd: number; totalUsd: number } | null;
  totalUsdPerMinute: number | null;
  aiUsdPerMinute: number | null;
  clips: Clip[];
}
interface Comparison {
  comparisonId: string;
  createdAt: string;
  video: string;
  variants: Variant[];
}

const usd = (n: number | null | undefined, digits = 4) => (n == null ? "—" : `$${n.toFixed(digits)}`);

/** Herramienta interna (solo administradores): los clips y el costo de cada pipeline, lado a lado. */
export function CompareView() {
  const t = useT();
  const [data, setData] = useState<Comparison[] | null>(null);
  const [error, setError] = useState("");
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
      {data === null ? <p className="text-sm text-muted">{t.common.loading}</p> : null}
      {data?.length === 0 ? <p className="text-sm text-muted">{t.compare.empty}</p> : null}
      {data?.map((c) => (
        <section key={c.comparisonId} className="space-y-3">
          <div>
            <h2 className="truncate text-lg font-bold">{c.video}</h2>
            <p className="text-xs text-muted">{new Date(c.createdAt).toLocaleString()}</p>
          </div>
          <div className="-mx-5 flex snap-x gap-3 overflow-x-auto px-5 pb-2 sm:mx-0 sm:grid sm:grid-cols-3 sm:px-0">
            {c.variants.map((v) => (
              <article key={v.pipeline} className="w-[85%] shrink-0 snap-start space-y-3 rounded-2xl border border-line bg-surface p-4 sm:w-auto">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="font-bold">{v.label}</h3>
                  <Link href={`/dashboard/videos/${v.videoId}`} className="text-xs text-accent underline">
                    {t.compare.openVideo}
                  </Link>
                </div>
                {v.status === "completed" ? (
                  <>
                    <div className="rounded-xl bg-background p-3">
                      <p className="text-2xl font-extrabold">{usd(v.totalUsdPerMinute)}</p>
                      <p className="text-xs text-muted">
                        {t.compare.total} {t.compare.perMinute} · {t.compare.ai}: {usd(v.aiUsdPerMinute)}
                      </p>
                    </div>
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                      <dt className="text-muted">{t.compare.transcription}</dt>
                      <dd className="text-right">{usd(v.costs?.transcriptionUsd)}</dd>
                      <dt className="text-muted">{t.compare.analysis}</dt>
                      <dd className="text-right">{usd((v.costs?.textUsd ?? 0) + (v.costs?.visionUsd ?? 0))}</dd>
                      <dt className="text-muted">{t.compare.compute}</dt>
                      <dd className="text-right">{usd(v.costs?.computeUsd)}</dd>
                      <dt className="text-muted">{t.compare.total}</dt>
                      <dd className="text-right font-semibold">{usd(v.costs?.totalUsd)}</dd>
                    </dl>
                    <p className="text-[11px] leading-4 text-muted">
                      {v.providers?.transcription ?? "—"} · {v.providers?.analysis ?? "—"}
                      {v.durationSeconds ? ` · ${formatDuration(v.durationSeconds)}` : ""}
                    </p>
                    {v.providers?.fallbackReason ? (
                      <p className="rounded-lg border border-yellow-500/40 px-2 py-1 text-[11px] text-yellow-200">
                        {t.compare.fallback}: {v.providers.fallbackReason}
                      </p>
                    ) : null}
                    {v.status === "completed" && v.ai !== "used" ? (
                      <p className="rounded-lg border border-red-500/40 px-2 py-1 text-[11px] text-red-200">
                        {t.compare.noAi}: {v.aiReason ?? v.ai ?? "—"}
                      </p>
                    ) : null}
                    <p className="text-sm font-semibold">{t.compare.clips(v.clipCount ?? 0)}</p>
                    {v.clips.length === 0 ? <p className="text-xs text-muted">{t.compare.noClips}</p> : null}
                    <ol className="space-y-2.5">
                      {v.clips.map((clip) => (
                        <li key={clip.id} className="flex gap-2.5">
                          <a
                            href={clip.videoUrl ?? undefined}
                            target="_blank"
                            rel="noreferrer"
                            className="relative block h-[85px] w-12 shrink-0 overflow-hidden rounded-lg bg-[#1d2433]"
                          >
                            {clip.thumbnailUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element -- URL firmada de S3 que caduca
                              <img src={clip.thumbnailUrl} alt="" className="h-full w-full object-cover" />
                            ) : null}
                          </a>
                          <div className="min-w-0 space-y-0.5">
                            <p className="line-clamp-2 text-[13px] font-semibold leading-4">{clip.title ?? "—"}</p>
                            <p className="text-[11px] text-muted">
                              {formatDuration(clip.startSeconds)}–{formatDuration(clip.endSeconds)} ·{" "}
                              {clip.score != null ? Math.round(clip.score * 100) : "—"}
                            </p>
                            {clip.reason ? <p className="line-clamp-3 text-[11px] leading-4 text-[#a3aabb]">{clip.reason}</p> : null}
                          </div>
                        </li>
                      ))}
                    </ol>
                  </>
                ) : (
                  <p className="text-sm text-muted">
                    {v.status === "failed" ? (v.errorMessage ?? v.status) : `${t.compare.waiting} ${v.progress}%`}
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
