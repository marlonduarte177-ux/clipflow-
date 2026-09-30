"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { DEFAULT_PRODUCT_CONFIG, type ClipDto, type ClipListResponse, type JobDto, type JobListResponse, type VideoDto } from "@clipflow/shared";
import { Alert } from "@/components/ui";
import { isActive, JobProgress } from "@/components/job-progress";
import { VideoStatusBadge } from "@/components/status-badge";
import { apiConfigured, apiFetch, formatBytes, formatDuration } from "@/lib/api";

interface Data {
  video: VideoDto;
  job: JobDto | undefined;
  clips: ClipDto[];
}

async function fetchData(videoId: string): Promise<Data> {
  const [video, jobs, clips] = await Promise.all([
    apiFetch<VideoDto>(`/videos/${videoId}`),
    apiFetch<JobListResponse>(`/jobs?videoId=${videoId}`),
    apiFetch<ClipListResponse>(`/videos/${videoId}/clips`),
  ]);
  return { video, job: jobs.jobs[0], clips: clips.clips };
}

export function VideoView({ videoId }: { videoId: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [showDiscarded, setShowDiscarded] = useState(false);
  const [duration, setDuration] = useState(DEFAULT_PRODUCT_CONFIG.defaultClipDurationSeconds);

  const [reloadKey, setReloadKey] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const router = useRouter();
  const processing = isActive(data?.job);

  useEffect(() => {
    if (!apiConfigured) return;
    let active = true;
    const load = () =>
      fetchData(videoId)
        .then((d) => active && (setData(d), setError("")))
        .catch((err: Error) => active && setError(err.message));
    void load();
    // Progreso real cada 5 s solo mientras se procesa (así no se reinician los videos al verlos).
    const timer = processing ? setInterval(load, 5000) : undefined;
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [videoId, processing, reloadKey]);

  async function jobAction(action: "cancel" | "retry") {
    if (!data?.job) return;
    try {
      const job = await apiFetch<JobDto>(`/jobs/${data.job.id}/${action}`, { method: "POST" });
      setData({ ...data, job });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function startProcessing() {
    if (!data) return;
    try {
      const job = await apiFetch<JobDto>(`/videos/${videoId}/process`, { method: "POST", body: { clipDurationSeconds: duration } });
      setData({ ...data, job });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function setClipStatus(clip: ClipDto, status: ClipDto["status"]) {
    try {
      const updated = await apiFetch<ClipDto>(`/clips/${clip.id}`, { method: "PATCH", body: { status } });
      setData((d) => d && { ...d, clips: d.clips.map((c) => (c.id === clip.id ? updated : c)) });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function deleteVideo() {
    if (!data || !window.confirm(`¿Eliminar "${data.video.originalFilename}" y todos sus clips? No se puede deshacer.`)) return;
    setDeleting(true);
    try {
      await apiFetch(`/videos/${videoId}`, { method: "DELETE" });
      router.replace("/dashboard");
    } catch (err) {
      setError((err as Error).message);
      setDeleting(false);
    }
  }

  async function download(clip: ClipDto) {
    try {
      const { url } = await apiFetch<{ url: string }>(`/clips/${clip.id}/download`);
      window.location.href = url;
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (!apiConfigured) return <Alert kind="error">La API todavía no está conectada a esta web.</Alert>;
  if (!data) return error ? <Alert kind="error">{error}</Alert> : <p className="text-sm text-muted">Cargando…</p>;

  const { video, job, clips } = data;
  const visible = clips.filter((c) => showDiscarded || c.status !== "discarded");
  const discardedCount = clips.length - clips.filter((c) => c.status !== "discarded").length;

  return (
    <div className="space-y-6">
      <Link href="/dashboard" className="text-sm text-muted hover:text-foreground">
        ← Proyectos
      </Link>

      <section className="space-y-3 rounded-2xl border border-line bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="min-w-0 truncate text-lg font-semibold">{video.originalFilename}</h1>
          <div className="flex items-center gap-3">
            <VideoStatusBadge status={video.status} />
            {job?.status !== "processing" ? (
              <button
                onClick={deleteVideo}
                disabled={deleting}
                className="rounded-lg border border-line px-3 py-1 text-xs text-muted hover:border-red-400 hover:text-red-400 disabled:opacity-50"
              >
                {deleting ? "Eliminando…" : "Eliminar video"}
              </button>
            ) : null}
          </div>
        </div>
        <p className="text-sm text-muted">
          {formatBytes(video.sizeBytes)} · {formatDuration(video.durationSeconds)}
          {job?.params.clipDurationSeconds ? ` · clips de ${job.params.clipDurationSeconds} s` : ""}
        </p>
        {video.rejectionReason ? <Alert kind="error">{video.rejectionReason}</Alert> : null}
        {job?.status === "completed" && job.result ? <AiStatus result={job.result} /> : null}
        {job ? (
          <JobProgress job={job} showHint />
        ) : video.status === "uploaded" || video.status === "ready" ? (
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm">
              <span className="mb-1 block text-muted">Duración de los clips</span>
              <select
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
                className="rounded-lg border border-line bg-background px-3 py-2"
              >
                {DEFAULT_PRODUCT_CONFIG.clipDurationsSeconds.map((d) => (
                  <option key={d} value={d}>
                    {d} s
                  </option>
                ))}
              </select>
            </label>
            <button onClick={startProcessing} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-black">
              Procesar video
            </button>
          </div>
        ) : null}
        <div className="flex gap-3 text-sm">
          {processing ? (
            <button onClick={() => jobAction("cancel")} className="rounded-lg border border-line px-3 py-1.5">
              Cancelar procesamiento
            </button>
          ) : null}
          {job && (job.status === "failed" || job.status === "cancelled") ? (
            <button onClick={() => jobAction("retry")} className="rounded-lg bg-accent px-3 py-1.5 font-medium text-black">
              Reintentar
            </button>
          ) : null}
        </div>
      </section>

      <Alert kind="error">{error}</Alert>

      {job?.status === "completed" ? (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-medium">Clips ({clips.length - discardedCount})</h2>
            {discardedCount > 0 ? (
              <button onClick={() => setShowDiscarded((v) => !v)} className="text-xs text-muted underline">
                {showDiscarded ? "Ocultar descartados" : `Ver descartados (${discardedCount})`}
              </button>
            ) : null}
          </div>
          {clips.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-line p-4 text-sm text-muted">
              No encontramos momentos que destaquen en este video (sin cambios claros de volumen ni de escena).
            </p>
          ) : null}
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map((clip, i) => (
              <li
                key={clip.id}
                className={`overflow-hidden rounded-2xl border bg-surface ${clip.status === "approved" ? "border-accent" : "border-line"} ${clip.status === "discarded" ? "opacity-50" : ""}`}
              >
                {clip.videoUrl ? (
                  <video
                    src={clip.videoUrl}
                    poster={clip.thumbnailUrl ?? undefined}
                    controls
                    playsInline
                    preload="none"
                    // Necesario para mostrar los subtítulos, que vienen de otro dominio (S3).
                    crossOrigin="anonymous"
                    // Las URLs caducan a los 15 min: si falla, se piden nuevas.
                    onError={() => setReloadKey((k) => (k < 3 ? k + 1 : k))}
                    className="aspect-[9/16] w-full bg-black object-cover"
                  >
                    {clip.subtitlesVttUrl ? (
                      <track kind="subtitles" src={clip.subtitlesVttUrl} label="Subtítulos" srcLang="es" default />
                    ) : null}
                  </video>
                ) : null}
                <div className="space-y-2 p-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{clip.title ?? `Momento ${i + 1}`}</span>
                    {clip.score != null ? (
                      <span className="text-xs text-muted" title="Intensidad relativa dentro de este video">
                        Score {Math.round(clip.score * 100)}
                      </span>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted">
                    {formatDuration(clip.startSeconds)} – {formatDuration(clip.endSeconds)} ·{" "}
                    {Math.round(clip.endSeconds - clip.startSeconds)} s
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {clip.status !== "approved" ? (
                      <button onClick={() => setClipStatus(clip, "approved")} className="rounded-lg bg-accent px-3 py-1 text-xs font-medium text-black">
                        Aprobar
                      </button>
                    ) : null}
                    {clip.status !== "discarded" ? (
                      <button onClick={() => setClipStatus(clip, "discarded")} className="rounded-lg border border-line px-3 py-1 text-xs">
                        Descartar
                      </button>
                    ) : (
                      <button onClick={() => setClipStatus(clip, "generated")} className="rounded-lg border border-line px-3 py-1 text-xs">
                        Recuperar
                      </button>
                    )}
                    <button onClick={() => download(clip)} className="rounded-lg border border-line px-3 py-1 text-xs">
                      Descargar
                    </button>
                    {clip.subtitlesSrtUrl ? (
                      <a href={clip.subtitlesSrtUrl} className="rounded-lg border border-line px-3 py-1 text-xs">
                        Subtítulos .srt
                      </a>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function AiStatus({ result }: { result: NonNullable<JobDto["result"]> }) {
  // Análisis de imágenes (experimental): solo se menciona si falló o quedó incompleto.
  const vision =
    result.vision === "unavailable" || result.visionReason ? (
      <p className="text-xs text-muted">
        Análisis de imágenes {result.vision === "unavailable" ? "no disponible" : "parcial"}
        {result.visionReason ? `: ${result.visionReason}` : ""}.
      </p>
    ) : null;
  return (
    <div className="space-y-1">
      <TextAiStatus result={result} />
      {vision}
    </div>
  );
}

function TextAiStatus({ result }: { result: NonNullable<JobDto["result"]> }) {
  if (result.ai === "used") {
    return (
      <p className="text-xs text-accent">
        Analizado con IA: transcripción, momentos por contenido, títulos y subtítulos
        {result.language ? ` · idioma: ${result.language}` : ""}.
      </p>
    );
  }
  if (result.ai === "no_speech") {
    return (
      <p className="text-xs text-muted">
        No se detectó habla (gameplay o música): los clips se eligieron por acción (disparos, golpes, picos de sonido),
        volumen y movimiento. Sin títulos ni subtítulos.
      </p>
    );
  }
  return (
    <p className="text-xs text-muted">
      Sin análisis de IA{result.aiReason ? `: ${result.aiReason}` : ""}. Los clips se eligieron por acción, volumen y movimiento.
    </p>
  );
}

