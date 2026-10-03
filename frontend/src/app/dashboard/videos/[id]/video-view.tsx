"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ClipDto, ClipListResponse, JobDto, JobListResponse, SubtitleStyle, VideoDownloadResponse, VideoDto } from "@clipflow/shared";
import { ClipViewer, FullTranscript, scoreOf } from "@/components/clip-viewer";
import { DEFAULT_DURATION, DurationPicker, SubtitlePicker } from "@/components/clip-options";
import { BackIcon, CheckIcon, DownloadIcon, RetryIcon, ShareIcon, TrashIcon } from "@/components/icons";
import { isActive, JobProgressPanel } from "@/components/job-progress";
import { Alert } from "@/components/ui";
import { apiConfigured, apiFetch, formatBytes, formatDuration } from "@/lib/api";
import { languageName } from "@/lib/language";
import { shareVideoFile } from "@/lib/share";

/** Compartir baja el video entero al celular: solo para videos no tan pesados. */
const MAX_SHARE_BYTES = 200 * 1024 * 1024;

interface Data {
  video: VideoDto;
  job: JobDto | undefined;
  clips: ClipDto[];
  transcript: ClipListResponse["transcript"];
}

async function fetchData(videoId: string): Promise<Data> {
  const [video, jobs, clips] = await Promise.all([
    apiFetch<VideoDto>(`/videos/${videoId}`),
    apiFetch<JobListResponse>(`/jobs?videoId=${videoId}`),
    apiFetch<ClipListResponse>(`/videos/${videoId}/clips`),
  ]);
  return { video, job: jobs.jobs[0], clips: clips.clips, transcript: clips.transcript ?? null };
}

type Filter = "all" | "approved" | "discarded";

export function VideoView({ videoId }: { videoId: string }) {
  const router = useRouter();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [viewer, setViewer] = useState<number | null>(null);
  const [fullTranscript, setFullTranscript] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [clipSeconds, setClipSeconds] = useState(DEFAULT_DURATION);
  const [subtitleStyle, setSubtitleStyle] = useState<SubtitleStyle>("highlight");
  const [saving, setSaving] = useState<"download" | "share" | null>(null);
  const [note, setNote] = useState("");
  const processing = isActive(data?.job);

  useEffect(() => {
    if (!apiConfigured) return;
    let active = true;
    const load = () =>
      fetchData(videoId)
        .then((d) => active && (setData(d), setError("")))
        .catch((err: Error) => active && setError(err.message));
    void load();
    // Progreso real cada 4 s solo mientras se procesa.
    const timer = processing ? setInterval(load, 4000) : undefined;
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
      const job = await apiFetch<JobDto>(`/videos/${videoId}/process`, {
        method: "POST",
        body: { clipDurationSeconds: clipSeconds, subtitleStyle },
      });
      setData({ ...data, job });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  /** URL temporal del video original (la pide al momento: caduca en minutos). */
  async function originalUrl() {
    return (await apiFetch<VideoDownloadResponse>(`/videos/${videoId}/download`)).url;
  }

  async function downloadOriginal() {
    setSaving("download");
    try {
      window.location.href = await originalUrl();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(null);
    }
  }

  async function shareOriginal() {
    if (!data) return;
    setSaving("share");
    setNote("");
    try {
      const name = data.video.originalFilename.replace(/\.[a-z0-9]{2,4}$/i, "");
      const result = await shareVideoFile(await originalUrl(), `${name}.mp4`, name);
      if (result === "unsupported") setNote("Este navegador no puede compartir videos directo: usa Descargar.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(null);
    }
  }

  const setClipStatus = useCallback(async (clip: ClipDto, status: ClipDto["status"]) => {
    try {
      const updated = await apiFetch<ClipDto>(`/clips/${clip.id}`, { method: "PATCH", body: { status } });
      // El PATCH no trae URLs nuevas: se conservan las que ya había.
      setData((d) => d && { ...d, clips: d.clips.map((c) => (c.id === clip.id ? { ...c, status: updated.status } : c)) });
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

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

  // Mejores primero (como en la vista previa del diseño).
  const sorted = useMemo(() => [...(data?.clips ?? [])].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)), [data?.clips]);
  const counts = {
    all: sorted.filter((c) => c.status !== "discarded").length,
    approved: sorted.filter((c) => c.status === "approved").length,
    discarded: sorted.filter((c) => c.status === "discarded").length,
  };
  const visible = sorted.filter((c) =>
    filter === "all" ? c.status !== "discarded" : filter === "approved" ? c.status === "approved" : c.status === "discarded",
  );
  const closeViewer = useCallback(() => setViewer(null), []);
  // Sin título: "Clip N" en orden cronológico (la API los devuelve por tiempo de inicio).
  const titleOf = (clip: ClipDto) => clip.title ?? `Clip ${(data?.clips.findIndex((c) => c.id === clip.id) ?? 0) + 1}`;

  if (!apiConfigured) return <Alert kind="error">La API todavía no está conectada a esta web.</Alert>;
  if (!data) return error ? <Alert kind="error">{error}</Alert> : <p className="text-sm text-muted">Cargando…</p>;

  const { video, job, transcript } = data;
  const result = job?.status === "completed" ? job.result : null;
  // "Solo descargar" terminado: el video está listo para bajarlo (y, si quiere, crear clips).
  const downloadReady = result?.downloadOnly === true;
  const language = languageName(result?.language ?? transcript?.language);
  const style = job?.params.subtitleStyle ?? "highlight";
  let origin: string | null = null;
  try {
    origin = video.sourceUrl ? `desde ${new URL(video.sourceUrl).hostname.replace(/^www\./, "")}` : null;
  } catch {
    origin = null;
  }
  const summary = (downloadReady ? [formatBytes(video.sizeBytes), formatDuration(video.durationSeconds), origin] : [
    job?.status === "completed" ? `${counts.all} clips` : video.sizeBytes > 0 ? formatBytes(video.sizeBytes) : origin,
    job?.params.clipDurationSeconds ? `de ${job.params.clipDurationSeconds} s` : formatDuration(video.durationSeconds),
    result?.ai === "used" && style !== "none" ? `subtítulos en ${(language ?? "su idioma").toLowerCase()}` : null,
  ])
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="space-y-5">
      <header className="-ml-2 flex items-center gap-2">
        <Link href="/dashboard" aria-label="Volver a Mis videos" className="grid h-11 w-11 shrink-0 place-items-center rounded-full hover:bg-surface">
          <BackIcon size={22} />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold sm:text-lg">{video.originalFilename}</h1>
          <p className="truncate text-xs text-muted">{summary}</p>
        </div>
        {!processing ? (
          <button
            onClick={deleteVideo}
            disabled={deleting}
            aria-label="Eliminar video"
            title="Eliminar video"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted hover:bg-surface hover:text-red-300 disabled:opacity-50"
          >
            <TrashIcon size={20} />
          </button>
        ) : null}
      </header>

      <Alert kind="error">{error}</Alert>
      {/* Si hay un procesamiento en curso o fallido, su tarjeta ya explica qué pasa. */}
      {video.rejectionReason && (!job || job.status === "completed") ? <Alert kind="error">{video.rejectionReason}</Alert> : null}

      {job && isActive(job) ? (
        <div className="mx-auto max-w-xl space-y-3">
          <JobProgressPanel job={job} subtitles={style !== "none"} imported={Boolean(video.sourceUrl)} />
          <button onClick={() => jobAction("cancel")} className="h-11 w-full text-sm text-muted underline">
            Cancelar procesamiento
          </button>
        </div>
      ) : null}

      {job && (job.status === "failed" || job.status === "cancelled") ? (
        <div className="mx-auto max-w-xl space-y-3 rounded-2xl border border-line bg-surface p-5">
          <p className="font-semibold">
            {job.status === "failed" ? (job.params.downloadOnly ? "No se pudo descargar el video" : "No se pudo procesar el video") : "Procesamiento cancelado"}
          </p>
          {job.errorMessage ? <p className="text-sm text-muted">{job.errorMessage}</p> : null}
          <button onClick={() => jobAction("retry")} className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-accent font-bold text-black">
            <RetryIcon size={18} />
            Reintentar
          </button>
        </div>
      ) : null}

      {!job && (video.status === "uploaded" || video.status === "ready") ? (
        <div className="mx-auto max-w-xl space-y-6">
          <DurationPicker value={clipSeconds} onChange={setClipSeconds} />
          <SubtitlePicker value={subtitleStyle} onChange={setSubtitleStyle} />
          <button onClick={startProcessing} className="h-14 w-full rounded-2xl bg-accent text-[17px] font-bold text-black">
            Crear clips
          </button>
        </div>
      ) : null}

      {downloadReady ? (
        <div className="mx-auto max-w-xl space-y-7">
          <div className="space-y-4 rounded-[22px] border border-line bg-surface p-5">
            <div className="flex items-center gap-3">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-accent text-black">
                <CheckIcon size={20} strokeWidth={3} />
              </span>
              <div className="min-w-0">
                <p className="font-semibold">Tu video está listo</p>
                <p className="text-[13px] text-muted">Guárdalo en tu celular o compártelo.</p>
              </div>
            </div>
            <div className={`grid gap-2.5 ${video.sizeBytes <= MAX_SHARE_BYTES ? "grid-cols-2" : "grid-cols-1"}`}>
              <button
                onClick={downloadOriginal}
                disabled={saving !== null}
                className="flex h-[54px] items-center justify-center gap-2 rounded-2xl bg-accent text-base font-bold text-black disabled:opacity-60"
              >
                <DownloadIcon size={20} strokeWidth={2.4} />
                {saving === "download" ? "Preparando…" : "Descargar"}
              </button>
              {video.sizeBytes <= MAX_SHARE_BYTES ? (
                <button
                  onClick={shareOriginal}
                  disabled={saving !== null}
                  className="flex h-[54px] items-center justify-center gap-2 rounded-2xl border border-[#2a3040] bg-background text-base font-semibold disabled:opacity-60"
                >
                  <ShareIcon size={20} />
                  {saving === "share" ? "Preparando…" : "Compartir"}
                </button>
              ) : null}
            </div>
            {note ? <p className="text-xs text-muted">{note}</p> : null}
          </div>

          <div className="space-y-5">
            <div className="space-y-1">
              <h2 className="text-lg font-bold">¿Quieres clips de este video?</h2>
              <p className="text-sm text-muted">Usamos el video que ya descargamos: no hay que volver a pegar el enlace.</p>
            </div>
            <DurationPicker value={clipSeconds} onChange={setClipSeconds} />
            <SubtitlePicker value={subtitleStyle} onChange={setSubtitleStyle} />
            <button onClick={startProcessing} className="h-14 w-full rounded-2xl bg-accent text-[17px] font-bold text-black">
              Crear clips
            </button>
          </div>
        </div>
      ) : null}

      {!job && video.status === "pending_upload" ? (
        <Alert kind="info">Esta subida no terminó. Vuelve a subir el video desde “Subir video”.</Alert>
      ) : null}

      {job?.status === "completed" && !downloadReady ? (
        <section className="space-y-4">
          {result && result.ai !== "used" ? <AiNote result={result} /> : null}
          {result?.chat === "used" ? (
            <p className="rounded-2xl border border-line bg-surface px-4 py-3 text-[13px] leading-[18px] text-muted">
              También se usó el chat del directo de Twitch para encontrar los momentos donde más reaccionó la gente.
            </p>
          ) : null}

          <div className="-mx-5 flex gap-2 overflow-x-auto px-5 sm:mx-0 sm:px-0" role="tablist" aria-label="Filtrar clips">
            {(
              [
                ["all", `Todos · ${counts.all}`],
                ["approved", `Aprobados · ${counts.approved}`],
                ["discarded", `Descartados${counts.discarded ? ` · ${counts.discarded}` : ""}`],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                role="tab"
                aria-selected={filter === id}
                onClick={() => setFilter(id)}
                className={`h-9 shrink-0 rounded-full border px-3.5 text-[13px] ${
                  filter === id ? "border-accent bg-accent font-semibold text-black" : "border-line bg-surface font-medium"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {data.clips.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-line p-5 text-sm text-muted">
              No encontramos momentos que destaquen en este video (sin cambios claros de voz, volumen ni de escena).
            </p>
          ) : visible.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-line p-5 text-sm text-muted">
              {filter === "approved" ? "Todavía no aprobaste ningún clip." : "No hay clips descartados."}
            </p>
          ) : (
            <ul className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 lg:grid-cols-4">
              {visible.map((clip, i) => {
                const score = scoreOf(clip);
                return (
                  <li key={clip.id}>
                    <button onClick={() => setViewer(i)} className="group flex w-full flex-col gap-2 text-left">
                      <span className="relative block aspect-[9/16] w-full overflow-hidden rounded-2xl bg-[#1d2433]">
                        {clip.thumbnailUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element -- URL firmada de S3 que caduca: no se optimiza
                          <img
                            src={clip.thumbnailUrl}
                            alt=""
                            loading="lazy"
                            onError={() => setReloadKey((k) => (k < 3 ? k + 1 : k))}
                            className="h-full w-full object-cover transition group-hover:scale-[1.02]"
                          />
                        ) : null}
                        {score != null ? (
                          <span className="absolute left-2.5 top-2.5 rounded-full bg-accent px-2 py-0.5 text-xs font-bold text-black">{score}</span>
                        ) : null}
                        {clip.status === "approved" ? (
                          <span className="absolute right-2.5 top-2.5 grid h-6 w-6 place-items-center rounded-full bg-background text-accent">
                            <CheckIcon size={13} strokeWidth={3} />
                          </span>
                        ) : null}
                        <span className="absolute bottom-2.5 right-2.5 rounded-lg bg-black/70 px-1.5 py-0.5 text-xs font-semibold">
                          {formatDuration(clip.endSeconds - clip.startSeconds)}
                        </span>
                      </span>
                      <span className="line-clamp-2 text-[13px] font-semibold leading-[17px]">{titleOf(clip)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : null}

      {viewer !== null && visible[viewer] ? (
        <ClipViewer
          clips={visible}
          index={viewer}
          titleOf={titleOf}
          language={language}
          onIndex={setViewer}
          onClose={closeViewer}
          onStatus={setClipStatus}
          onError={setError}
          onShowFullTranscript={transcript ? () => setFullTranscript(true) : undefined}
        />
      ) : null}
      {fullTranscript && transcript ? (
        <FullTranscript url={transcript.vttUrl} language={language} onClose={() => setFullTranscript(false)} />
      ) : null}
    </div>
  );
}

/** Por qué no hubo análisis con IA (sin habla, sin clave, error), en lenguaje simple. */
function AiNote({ result }: { result: NonNullable<JobDto["result"]> }) {
  const text =
    result.ai === "no_speech"
      ? "No se detectó habla (gameplay o música): los clips se eligieron por acción, volumen y movimiento. Sin títulos ni subtítulos."
      : result.ai === "no_audio"
        ? "El video no tiene audio: los clips se eligieron por movimiento y cambios de escena."
        : result.ai === "unavailable" && result.language
          ? // Falló solo el análisis de momentos: la transcripción se conservó.
            `La IA no pudo elegir los momentos${result.aiReason ? ` (${result.aiReason})` : ""}. Se eligieron por acción, volumen y movimiento; los subtítulos y la transcripción sí están.`
          : `Sin análisis de IA${result.aiReason ? `: ${result.aiReason}` : ""}. Los clips se eligieron por acción, volumen y movimiento.`;
  return <p className="rounded-2xl border border-line bg-surface px-4 py-3 text-[13px] leading-[18px] text-muted">{text}</p>;
}
