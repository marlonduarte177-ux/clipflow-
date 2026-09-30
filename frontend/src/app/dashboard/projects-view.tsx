"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import type { ProjectDto, ProjectListResponse, VideoDto, VideoListResponse } from "@clipflow/shared";
import { Alert, Field } from "@/components/ui";
import { VideoStatusBadge } from "@/components/status-badge";
import { apiConfigured, apiFetch, formatBytes, formatDuration } from "@/lib/api";

async function fetchAll() {
  const [p, v] = await Promise.all([apiFetch<ProjectListResponse>("/projects"), apiFetch<VideoListResponse>("/videos")]);
  return { projects: p.projects, videos: v.videos };
}

export function ProjectsView() {
  const [projects, setProjects] = useState<ProjectDto[] | null>(null);
  const [videos, setVideos] = useState<VideoDto[]>([]);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  function show(data: Awaited<ReturnType<typeof fetchAll>>) {
    setProjects(data.projects);
    setVideos(data.videos);
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

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    setCreating(true);
    try {
      await apiFetch<ProjectDto>("/projects", { method: "POST", body: { name } });
      setName("");
      show(await fetchAll());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  if (!apiConfigured) {
    return <Alert kind="error">La API todavía no está conectada a esta web (falta NEXT_PUBLIC_API_URL).</Alert>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-semibold">Proyectos</h1>
        <Link href="/dashboard/subir" className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-black">
          Subir video
        </Link>
      </div>

      <form onSubmit={onCreate} className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Field label="Nuevo proyecto" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej.: Podcast semanal" />
        </div>
        <button type="submit" disabled={creating || !name.trim()} className="rounded-lg border border-line px-4 py-2.5 text-sm disabled:opacity-50">
          {creating ? "Creando…" : "Crear proyecto"}
        </button>
      </form>

      <Alert kind="error">{error}</Alert>

      {projects === null && !error ? <p className="text-sm text-muted">Cargando…</p> : null}
      {projects?.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line p-6 text-sm text-muted">
          Todavía no tienes proyectos. Crea uno para empezar a subir videos.
        </p>
      ) : null}

      <ul className="space-y-4">
        {projects?.map((project) => {
          const projectVideos = videos.filter((v) => v.projectId === project.id);
          return (
            <li key={project.id} className="rounded-2xl border border-line bg-surface p-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="font-medium">{project.name}</h2>
                <Link href={`/dashboard/subir?projectId=${project.id}`} className="text-sm text-accent hover:underline">
                  + Video
                </Link>
              </div>
              {projectVideos.length === 0 ? (
                <p className="mt-2 text-sm text-muted">Sin videos.</p>
              ) : (
                <ul className="mt-3 divide-y divide-line">
                  {projectVideos.map((video) => (
                    <li key={video.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                      <span className="min-w-0 flex-1 truncate">{video.originalFilename}</span>
                      <span className="text-muted">
                        {formatBytes(video.sizeBytes)} · {formatDuration(video.durationSeconds)}
                      </span>
                      <VideoStatusBadge status={video.status} />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
