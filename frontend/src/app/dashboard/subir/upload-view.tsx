"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { DEFAULT_PRODUCT_CONFIG, resolveVideoMimeType, type ProjectDto, type ProjectListResponse, type VideoDto } from "@clipflow/shared";
import { Alert } from "@/components/ui";
import { apiConfigured, apiFetch, formatBytes, formatDuration } from "@/lib/api";
import { readVideoDuration, uploadVideo, type UploadProgress } from "@/lib/uploader";

// Límites mostrados al usuario; la API los vuelve a comprobar siempre.
const LIMITS = DEFAULT_PRODUCT_CONFIG.upload;

type Phase = "idle" | "uploading" | "done" | "error" | "cancelled";

export function UploadView() {
  const params = useSearchParams();
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [projectId, setProjectId] = useState(params.get("projectId") ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [fileError, setFileError] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<VideoDto | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const videoRef = useRef<VideoDto | null>(null);

  useEffect(() => {
    if (!apiConfigured) return;
    apiFetch<ProjectListResponse>("/projects")
      .then((r) => {
        setProjects(r.projects);
        setProjectId((current) => current || r.projects[0]?.id || "");
      })
      .catch((err: Error) => setMessage(err.message));
  }, []);

  // Durante la subida: avisa antes de cerrar la pestaña y evita que la pantalla se apague
  // (en el celular, con la pantalla bloqueada el navegador pausa la subida).
  useEffect(() => {
    if (phase !== "uploading") return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    let lock: WakeLockSentinel | null = null;
    navigator.wakeLock
      ?.request("screen")
      .then((l) => (lock = l))
      .catch(() => undefined);
    return () => {
      window.removeEventListener("beforeunload", warn);
      void lock?.release().catch(() => undefined);
    };
  }, [phase]);

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0] ?? null;
    setFile(null);
    setDuration(null);
    setFileError("");
    setPhase("idle");
    setResult(null);
    if (!selected) return;
    if (!resolveVideoMimeType(selected.name, selected.type, LIMITS.allowedMimeTypes)) {
      setFileError("Formato no admitido. Usa MP4, MOV, WEBM o MKV.");
      return;
    }
    if (selected.size > LIMITS.maxBytes) {
      setFileError(`El archivo supera el máximo de ${formatBytes(LIMITS.maxBytes)}.`);
      return;
    }
    setFile(selected);
    const seconds = await readVideoDuration(selected);
    if (seconds && seconds > LIMITS.maxDurationSeconds) {
      setFileError(`El video dura ${formatDuration(seconds)}; el máximo es ${formatDuration(LIMITS.maxDurationSeconds)}.`);
      setFile(null);
      return;
    }
    setDuration(seconds);
  }

  async function onUpload() {
    if (!file || !projectId) return;
    const controller = new AbortController();
    abortRef.current = controller;
    videoRef.current = null;
    setPhase("uploading");
    setMessage("");
    setProgress({ uploadedBytes: 0, totalBytes: file.size });
    try {
      const video = await uploadVideo({
        file,
        projectId,
        durationSeconds: duration,
        signal: controller.signal,
        onProgress: setProgress,
        onCreated: (v) => (videoRef.current = v),
      });
      setResult(video);
      setPhase("done");
    } catch (err) {
      if (controller.signal.aborted) return;
      setMessage((err as Error).message);
      setPhase("error");
      // Libera la subida en S3 para no dejar partes huérfanas.
      const created = videoRef.current as VideoDto | null;
      if (created) await apiFetch(`/videos/${created.id}/abort`, { method: "POST" }).catch(() => undefined);
    }
  }

  async function onCancel() {
    abortRef.current?.abort();
    setPhase("cancelled");
    if (videoRef.current) await apiFetch(`/videos/${videoRef.current.id}/abort`, { method: "POST" }).catch(() => undefined);
  }

  if (!apiConfigured) {
    return <Alert kind="error">La API todavía no está conectada a esta web (falta NEXT_PUBLIC_API_URL).</Alert>;
  }

  const percent = progress && progress.totalBytes > 0 ? Math.floor((progress.uploadedBytes / progress.totalBytes) * 100) : 0;
  const busy = phase === "uploading";

  return (
    <div className="mx-auto max-w-xl space-y-5">
      <h1 className="text-2xl font-semibold">Subir video</h1>

      {projects.length === 0 && !message ? (
        <p className="rounded-2xl border border-dashed border-line p-4 text-sm text-muted">
          Primero <Link href="/dashboard" className="text-accent underline">crea un proyecto</Link>.
        </p>
      ) : null}

      <label className="block">
        <span className="mb-1 block text-sm text-muted">Proyecto</span>
        <select
          value={projectId}
          disabled={busy}
          onChange={(e) => setProjectId(e.target.value)}
          className="w-full rounded-lg border border-line bg-background px-3 py-2.5"
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>

      <label className="block rounded-2xl border border-dashed border-line bg-surface p-6 text-center">
        <span className="block font-medium">Elige un video</span>
        <span className="mt-1 block text-xs text-muted">
          MP4, MOV, WEBM o MKV · hasta {formatBytes(LIMITS.maxBytes)} · hasta {formatDuration(LIMITS.maxDurationSeconds)}
        </span>
        <input type="file" accept="video/mp4,video/quicktime,video/webm,video/x-matroska,.mkv" disabled={busy} onChange={onFile} className="mt-4 w-full text-sm" />
      </label>

      <Alert kind="error">{fileError}</Alert>

      {file ? (
        <dl className="grid grid-cols-3 gap-2 rounded-2xl border border-line p-4 text-sm">
          <div className="col-span-3 truncate">
            <dt className="text-muted">Archivo</dt>
            <dd>{file.name}</dd>
          </div>
          <div>
            <dt className="text-muted">Tamaño</dt>
            <dd>{formatBytes(file.size)}</dd>
          </div>
          <div>
            <dt className="text-muted">Duración</dt>
            <dd>{duration ? formatDuration(duration) : "No disponible"}</dd>
          </div>
        </dl>
      ) : null}

      {progress && phase !== "idle" ? (
        <div>
          <div className="h-2 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full bg-accent transition-all" style={{ width: `${percent}%` }} />
          </div>
          <p className="mt-2 text-sm text-muted">
            {percent}% · {formatBytes(progress.uploadedBytes)} de {formatBytes(progress.totalBytes)}
          </p>
        </div>
      ) : null}

      {phase === "done" && result ? (
        <Alert kind="info">
          Video subido y guardado de forma privada. El procesamiento automático se habilita en la siguiente fase.{" "}
          <Link href="/dashboard" className="underline">Ver proyectos</Link>
        </Alert>
      ) : null}
      {busy ? (
        <p className="text-xs text-muted">No cierres esta pestaña ni bloquees el celular hasta que termine.</p>
      ) : null}
      {phase === "cancelled" ? <Alert kind="info">Subida cancelada.</Alert> : null}
      <Alert kind="error">{message}</Alert>

      <div className="flex gap-3">
        {busy ? (
          <button onClick={onCancel} className="flex-1 rounded-lg border border-line px-4 py-2.5">
            Cancelar
          </button>
        ) : (
          <button
            onClick={onUpload}
            disabled={!file || !projectId}
            className="flex-1 rounded-lg bg-accent px-4 py-2.5 font-medium text-black disabled:opacity-50"
          >
            Subir
          </button>
        )}
      </div>
    </div>
  );
}
