"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import type { JobDto, JobListResponse, ProjectDto, ProjectListResponse, VideoDto, VideoListResponse } from "@clipflow/shared";
import { DownIcon, NextIcon, PlusIcon, TrashIcon, UploadIcon, VideosIcon } from "@/components/icons";
import { isActive, JobProgress } from "@/components/job-progress";
import { Alert } from "@/components/ui";
import { apiConfigured, apiFetch, formatDuration } from "@/lib/api";

async function fetchAll() {
  const [p, v, j] = await Promise.all([
    apiFetch<ProjectListResponse>("/projects"),
    apiFetch<VideoListResponse>("/videos"),
    apiFetch<JobListResponse>("/jobs"),
  ]);
  // Último trabajo de cada video (la API los devuelve del más nuevo al más viejo).
  const jobs: Record<string, JobDto> = {};
  for (const job of j.jobs) jobs[job.videoId] ??= job;
  return { projects: p.projects, videos: v.videos, jobs };
}

/** Inicio: tus videos, con su estado, y acceso a sus clips. */
export function ProjectsView() {
  const [projects, setProjects] = useState<ProjectDto[] | null>(null);
  const [videos, setVideos] = useState<VideoDto[]>([]);
  const [jobs, setJobs] = useState<Record<string, JobDto>>({});
  const [projectFilter, setProjectFilter] = useState("all");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  function show(data: Awaited<ReturnType<typeof fetchAll>>) {
    setProjects(data.projects);
    setVideos(data.videos);
    setJobs(data.jobs);
    setError("");
  }

  useEffect(() => {
    if (!apiConfigured) return;
    let active = true;
    fetchAll()
      .then((data) => active && show(data))
      .catch((err: Error) => active && setError(err.message));
    return () => {
      active = false;
    };
  }, []);

  // Mientras haya videos procesándose, se actualiza el progreso real cada 5 s.
  const anyActive = Object.values(jobs).some(isActive);
  useEffect(() => {
    if (!anyActive) return;
    const timer = setInterval(() => {
      fetchAll()
        .then(show)
        .catch(() => undefined);
    }, 5000);
    return () => clearInterval(timer);
  }, [anyActive]);

  async function onDelete(video: VideoDto) {
    const question =
      video.status === "pending_upload"
        ? `¿Descartar la subida sin terminar de "${video.originalFilename}"?`
        : `¿Eliminar "${video.originalFilename}" y todos sus clips? No se puede deshacer.`;
    if (!window.confirm(question)) return;
    setBusy(video.id);
    try {
      await apiFetch(`/videos/${video.id}`, { method: "DELETE" });
      show(await fetchAll());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onCreateProject(event: FormEvent) {
    event.preventDefault();
    try {
      const project = await apiFetch<ProjectDto>("/projects", { method: "POST", body: { name } });
      setName("");
      setCreating(false);
      show(await fetchAll());
      setProjectFilter(project.id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (!apiConfigured) {
    return <Alert kind="error">La API todavía no está conectada a esta web (falta NEXT_PUBLIC_API_URL).</Alert>;
  }

  const shown = projectFilter === "all" ? videos : videos.filter((v) => v.projectId === projectFilter);
  const readyClips = shown.reduce((n, v) => n + (v.clipCount ?? 0), 0);
  const selected = projects?.find((p) => p.id === projectFilter);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-[28px] font-bold tracking-tight">Tus videos</h1>
          <p className="text-sm text-muted">
            {projects === null ? "Cargando…" : `${shown.length} ${shown.length === 1 ? "video" : "videos"} · ${readyClips} clips listos`}
          </p>
        </div>
        {projects && projects.length > 0 ? (
          <div className="flex items-center gap-2">
            <label className="relative flex h-9 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[13px]">
              <span className="text-muted">Proyecto:</span>
              <span className="max-w-[9rem] truncate font-semibold">{selected?.name ?? "Todos"}</span>
              <DownIcon size={14} />
              <select
                aria-label="Filtrar por proyecto"
                value={projectFilter}
                onChange={(e) => setProjectFilter(e.target.value)}
                className="absolute inset-0 cursor-pointer opacity-0"
              >
                <option value="all">Todos</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              onClick={() => setCreating((v) => !v)}
              aria-label="Nuevo proyecto"
              title="Nuevo proyecto"
              className="grid h-9 w-9 place-items-center rounded-full border border-line bg-surface"
            >
              <PlusIcon size={16} />
            </button>
          </div>
        ) : null}
      </div>

      {creating ? (
        <form onSubmit={onCreateProject} className="flex gap-2 rounded-2xl border border-line bg-surface p-3">
          <label className="sr-only" htmlFor="new-project">
            Nombre del proyecto
          </label>
          <input
            id="new-project"
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ej.: Podcast semanal"
            className="min-w-0 flex-1 rounded-xl border border-line bg-background px-3 text-base outline-none focus:border-accent"
          />
          <button type="submit" disabled={!name.trim()} className="h-11 rounded-xl bg-accent px-4 text-sm font-semibold text-black disabled:opacity-50">
            Crear
          </button>
        </form>
      ) : null}

      <Alert kind="error">{error}</Alert>

      {projects !== null && shown.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-[22px] border-2 border-dashed border-[#2b3140] px-6 py-12 text-center">
          <span className="grid h-14 w-14 place-items-center rounded-[18px] bg-surface text-muted">
            <VideosIcon size={26} />
          </span>
          <p className="font-semibold">Todavía no hay videos aquí</p>
          <p className="max-w-xs text-sm text-muted">Sube un video largo y te damos sus mejores momentos listos para redes.</p>
          <Link href="/dashboard/subir" className="mt-2 flex h-12 items-center gap-2 rounded-2xl bg-accent px-5 font-bold text-black">
            <UploadIcon size={18} strokeWidth={2.4} />
            Subir video
          </Link>
        </div>
      ) : null}

      <ul className="grid gap-3 lg:grid-cols-2">
        {shown.map((video) => {
          const job = jobs[video.id];
          const pending = video.status === "pending_upload";
          const body = (
            <>
              <span className="relative block h-[86px] w-16 shrink-0 overflow-hidden rounded-[10px] bg-[#1d2433]">
                {video.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- URL firmada de S3 que caduca: no se optimiza
                  <img src={video.thumbnailUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
                ) : (
                  <span className="grid h-full w-full place-items-center text-[#3a4256]">
                    <VideosIcon size={22} />
                  </span>
                )}
              </span>
              <span className="flex min-w-0 flex-1 flex-col justify-center gap-2">
                <span className="truncate text-[15px] font-semibold">{video.originalFilename}</span>
                <VideoState video={video} job={job} />
              </span>
            </>
          );
          return (
            <li key={video.id} className="flex items-center gap-1 rounded-[18px] border border-line bg-surface pr-1.5">
              {pending ? (
                <div className="flex min-w-0 flex-1 gap-3.5 p-3">{body}</div>
              ) : (
                <Link href={`/dashboard/videos/${video.id}`} className="flex min-w-0 flex-1 gap-3.5 p-3">
                  {body}
                  <NextIcon size={20} className="shrink-0 self-center text-[#5b6377]" />
                </Link>
              )}
              {job?.status !== "processing" ? (
                <button
                  onClick={() => onDelete(video)}
                  disabled={busy === video.id}
                  aria-label={pending ? `Descartar ${video.originalFilename}` : `Eliminar ${video.originalFilename}`}
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-[#5b6377] hover:text-red-300 disabled:opacity-50"
                >
                  <TrashIcon size={18} />
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function VideoState({ video, job }: { video: VideoDto; job: JobDto | undefined }) {
  if (video.status === "pending_upload") return <span className="text-xs text-yellow-200">Subida sin terminar</span>;
  if (video.status === "rejected") return <span className="text-xs text-red-300">{video.rejectionReason ?? "Video rechazado"}</span>;
  if (job && isActive(job)) return <JobProgress job={job} />;
  if (job?.status === "completed") {
    return (
      <span className="flex items-center gap-2">
        <span className="rounded-full bg-accent px-2.5 py-0.5 text-xs font-bold text-black">
          {video.clipCount ?? 0} {video.clipCount === 1 ? "clip listo" : "clips listos"}
        </span>
        <span className="text-xs text-muted">{formatDuration(video.durationSeconds)}</span>
      </span>
    );
  }
  if (job) return <JobProgress job={job} />;
  return <span className="text-xs text-muted">Listo para crear clips</span>;
}
