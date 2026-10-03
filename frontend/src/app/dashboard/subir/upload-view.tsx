"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  checkImportUrl,
  DEFAULT_PRODUCT_CONFIG,
  FEATURES,
  resolveVideoMimeType,
  type ImportVideoResponse,
  type ProjectDto,
  type ProjectListResponse,
  type SubtitleStyle,
  type VideoDto,
} from "@clipflow/shared";
import { DEFAULT_DURATION, DurationPicker, SubtitlePicker } from "@/components/clip-options";
import { CheckIcon, CloseIcon, DownIcon, DownloadIcon, LinesIcon, UploadIcon } from "@/components/icons";
import { RightsDialog } from "@/components/rights-dialog";
import { Alert } from "@/components/ui";
import { apiConfigured, apiFetch, formatBytes, formatDuration } from "@/lib/api";
import { readVideoDuration, uploadVideo, type UploadProgress } from "@/lib/uploader";

// Límites mostrados al usuario; la API los vuelve a comprobar siempre.
const LIMITS = DEFAULT_PRODUCT_CONFIG.upload;
const DEFAULT_PROJECT_NAME = "Mis videos";

type Phase = "idle" | "uploading" | "uploaded" | "starting" | "error";

/**
 * Subir video: el archivo empieza a subirse apenas se elige y, mientras tanto, el usuario elige
 * la duración de los clips y el estilo de subtítulos. "Crear clips" confirma: si la subida no
 * terminó, el procesamiento empieza solo en cuanto termine.
 */
export function UploadView() {
  const router = useRouter();
  const params = useSearchParams();
  const [projects, setProjects] = useState<ProjectDto[] | null>(null);
  const [projectId, setProjectId] = useState(params.get("projectId") ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [videoSeconds, setVideoSeconds] = useState<number | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [error, setError] = useState("");
  const [clipSeconds, setClipSeconds] = useState(DEFAULT_DURATION);
  const [subtitleStyle, setSubtitleStyle] = useState<SubtitleStyle>("highlight");
  const [confirmed, setConfirmed] = useState(false);
  // Subir un archivo o importar desde un enlace (lo descarga el worker).
  const [source, setSource] = useState<"file" | "link">("file");
  const [link, setLink] = useState("");
  const [askRights, setAskRights] = useState(false);
  const [importing, setImporting] = useState(false);
  /** Por enlace: crear clips o solo bajar el video. */
  const [importMode, setImportMode] = useState<"clips" | "download">("clips");

  const abortRef = useRef<AbortController | null>(null);
  const videoRef = useRef<VideoDto | null>(null);
  // "Crear clips" resuelve esta promesa; la subida la espera antes de confirmar.
  const confirmRef = useRef<((options: { clipDurationSeconds: number; subtitleStyle: SubtitleStyle }) => void) | null>(null);

  useEffect(() => {
    if (!apiConfigured) return;
    apiFetch<ProjectListResponse>("/projects")
      .then((r) => {
        setProjects(r.projects);
        setProjectId((current) => current || r.projects[0]?.id || "");
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  // Durante la subida: avisa antes de cerrar la pestaña y evita que la pantalla se apague
  // (en el celular, con la pantalla bloqueada el navegador pausa la subida).
  const uploading = phase === "uploading" || phase === "uploaded" || phase === "starting";
  useEffect(() => {
    if (!uploading) return;
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
  }, [uploading]);

  async function ensureProject(): Promise<string> {
    if (projectId) return projectId;
    const created = await apiFetch<ProjectDto>("/projects", { method: "POST", body: { name: DEFAULT_PROJECT_NAME } });
    setProjects((list) => [...(list ?? []), created]);
    setProjectId(created.id);
    return created.id;
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!selected) return;
    setError("");
    if (!resolveVideoMimeType(selected.name, selected.type, LIMITS.allowedMimeTypes)) {
      setError("Formato no admitido. Usa MP4, MOV, WEBM o MKV.");
      return;
    }
    if (selected.size > LIMITS.maxBytes) {
      setError(`El archivo supera el máximo de ${formatBytes(LIMITS.maxBytes)}.`);
      return;
    }
    const seconds = await readVideoDuration(selected);
    if (seconds && seconds > LIMITS.maxDurationSeconds) {
      setError(`El video dura ${formatDuration(seconds)}; el máximo es ${formatDuration(LIMITS.maxDurationSeconds)}.`);
      return;
    }
    setFile(selected);
    setVideoSeconds(seconds);
    void start(selected, seconds);
  }

  async function start(selected: File, seconds: number | null) {
    const controller = new AbortController();
    abortRef.current = controller;
    videoRef.current = null;
    setConfirmed(false);
    setPhase("uploading");
    setProgress({ uploadedBytes: 0, totalBytes: selected.size });
    const confirmation = new Promise<{ clipDurationSeconds: number; subtitleStyle: SubtitleStyle }>((resolve) => {
      confirmRef.current = resolve;
    });
    try {
      const project = await ensureProject();
      const video = await uploadVideo({
        file: selected,
        projectId: project,
        durationSeconds: seconds,
        signal: controller.signal,
        onProgress: setProgress,
        onCreated: (v) => (videoRef.current = v),
        onUploaded: () => setPhase((p) => (p === "uploading" ? "uploaded" : p)),
        completeWith: () => confirmation,
      });
      router.push(`/dashboard/videos/${video.id}`);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError((err as Error).message);
      setPhase("error");
      // Libera la subida en S3 para no dejar partes huérfanas. (El tipo se fuerza: TS no ve la
      // asignación que hace onCreated dentro de la subida.)
      const created = videoRef.current as VideoDto | null;
      if (created) await apiFetch(`/videos/${created.id}/abort`, { method: "POST" }).catch(() => undefined);
    }
  }

  function onImportClick(mode: "clips" | "download") {
    const checked = checkImportUrl(link);
    if (!checked.ok) {
      setError(checked.message);
      return;
    }
    setError("");
    setImportMode(mode);
    setAskRights(true);
  }

  async function onConfirmImport() {
    setImporting(true);
    try {
      const project = await ensureProject();
      const { video } = await apiFetch<ImportVideoResponse>("/videos/import", {
        method: "POST",
        body:
          importMode === "download"
            ? { projectId: project, url: link.trim(), rightsConfirmed: true, downloadOnly: true }
            : { projectId: project, url: link.trim(), rightsConfirmed: true, clipDurationSeconds: clipSeconds, subtitleStyle },
      });
      router.push(`/dashboard/videos/${video.id}`);
    } catch (err) {
      setError((err as Error).message);
      setAskRights(false);
      setImporting(false);
    }
  }

  function onCreateClips() {
    setConfirmed(true);
    setPhase((p) => (p === "uploaded" ? "starting" : p));
    confirmRef.current?.({ clipDurationSeconds: clipSeconds, subtitleStyle });
  }

  async function onCancel() {
    abortRef.current?.abort();
    const created = videoRef.current;
    setFile(null);
    setProgress(null);
    setPhase("idle");
    setConfirmed(false);
    if (created) await apiFetch(`/videos/${created.id}/abort`, { method: "POST" }).catch(() => undefined);
  }

  if (!apiConfigured) {
    return <Alert kind="error">La API todavía no está conectada a esta web (falta NEXT_PUBLIC_API_URL).</Alert>;
  }

  const percent = progress && progress.totalBytes > 0 ? Math.floor((progress.uploadedBytes / progress.totalBytes) * 100) : 0;
  const project = projects?.find((p) => p.id === projectId);

  return (
    <div className="mx-auto max-w-xl space-y-6 pb-24 sm:pb-0">
      <div className="space-y-1.5">
        <h1 className="text-[28px] font-bold tracking-tight">Nuevo video</h1>
        <p className="text-sm text-muted">
          {file ? "Elige cómo quieres tus clips mientras el video se sube." : "Sube un video largo y te damos sus mejores momentos listos para TikTok, Reels y Shorts."}
        </p>
      </div>

      {!file ? (
        <div role="tablist" aria-label="Origen del video" className="grid grid-cols-2 gap-1 rounded-2xl border border-line bg-surface p-1">
          {(
            [
              ["file", "Archivo"],
              ["link", "Enlace"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={source === id}
              onClick={() => {
                setSource(id);
                setError("");
              }}
              className={`h-10 rounded-xl text-sm font-semibold transition ${source === id ? "bg-accent text-on-accent" : "text-muted hover:text-foreground"}`}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}

      {source === "link" && !file ? (
        <div className="space-y-2.5 rounded-[22px] border border-line bg-surface p-4">
          <label htmlFor="video-link" className="flex items-center gap-2 text-[15px] font-semibold">
            <LinesIcon size={18} className="text-accent" />
            Enlace del video
          </label>
          <input
            id="video-link"
            type="url"
            inputMode="url"
            autoComplete="off"
            value={link}
            onChange={(e) => {
              setLink(e.target.value);
              setError("");
            }}
            placeholder="https://www.tiktok.com/@…/video/…"
            className="h-12 w-full rounded-xl border border-line bg-background px-3.5 text-base outline-none focus:border-accent"
          />
          {/* Otra acción con el mismo enlace: bajar el video tal cual, sin clips (si está activada). */}
          {FEATURES.downloadOnly ? (
          <button
            type="button"
            onClick={() => onImportClick("download")}
            disabled={!link.trim() || importing}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-accent/50 text-[15px] font-semibold text-accent transition hover:bg-accent/10 disabled:opacity-40"
          >
            <DownloadIcon size={18} strokeWidth={2.4} />
            Descargar solo el video
          </button>
          ) : null}
          <p className="text-xs leading-[17px] text-muted">
            TikTok, Instagram, Facebook, Kick o Twitch (clips y videos guardados), o un enlace directo a un archivo de video. Lo procesamos en nuestros servidores: no gasta
            tus datos. Hasta {formatDuration(LIMITS.maxDurationSeconds)}. Para YouTube, descarga el video y súbelo como archivo.
          </p>
        </div>
      ) : file ? (
        <div className="flex items-center gap-3.5 rounded-[18px] border border-line bg-surface p-3">
          <div className="grid h-[76px] w-14 shrink-0 place-items-center rounded-[10px] bg-[#1d2433] text-accent">
            {phase === "uploaded" || phase === "starting" ? <CheckIcon size={24} strokeWidth={2.6} /> : <UploadIcon size={22} />}
          </div>
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="truncate text-[15px] font-semibold">{file.name}</p>
            <p className="text-[13px] text-muted">
              {formatBytes(file.size)}
              {videoSeconds ? ` · ${formatDuration(videoSeconds)}` : ""}
            </p>
            <div className="h-1.5 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label="Avance de la subida">
              <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${percent}%` }} />
            </div>
            <p className="text-xs text-muted">
              {phase === "uploading" ? `Subiendo… ${percent} %` : phase === "error" ? "La subida se detuvo" : "Video subido"}
            </p>
          </div>
          {phase === "uploading" || phase === "uploaded" || phase === "error" ? (
            <button onClick={onCancel} aria-label="Cancelar la subida" className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-line text-muted hover:text-foreground">
              <CloseIcon size={18} />
            </button>
          ) : null}
        </div>
      ) : (
        <label className="flex cursor-pointer flex-col items-center gap-3 rounded-[22px] border-2 border-dashed border-[#2b3140] bg-surface px-6 py-10 text-center transition hover:border-accent">
          <span className="grid h-14 w-14 place-items-center rounded-[18px] bg-accent text-on-accent">
            <UploadIcon size={26} strokeWidth={2.4} />
          </span>
          <span className="text-base font-semibold">Elegir video</span>
          <span className="text-xs text-muted">
            MP4, MOV, WEBM o MKV · hasta {formatBytes(LIMITS.maxBytes)} · hasta {formatDuration(LIMITS.maxDurationSeconds)}
          </span>
          <input type="file" accept="video/mp4,video/quicktime,video/webm,video/x-matroska,.mkv" onChange={onFile} className="sr-only" />
        </label>
      )}
      {source === "file" && !file ? (
        <p className="-mt-3 text-center text-xs text-muted">Al subir un video confirmas que es tuyo o que tienes permiso para usarlo.</p>
      ) : null}

      <Alert kind="error">{error}</Alert>

      <DurationPicker value={clipSeconds} onChange={setClipSeconds} disabled={confirmed} />
      <SubtitlePicker value={subtitleStyle} onChange={setSubtitleStyle} disabled={confirmed} />

      {projects && projects.length > 0 ? (
        <label className="relative flex min-h-[52px] items-center justify-between gap-3 rounded-2xl border border-line bg-surface px-4">
          <span className="text-sm text-muted">Proyecto</span>
          <span className="flex items-center gap-1.5 text-sm font-semibold">
            {project?.name ?? "Elegir"}
            <DownIcon size={16} />
          </span>
          <select
            aria-label="Proyecto"
            value={projectId}
            disabled={phase !== "idle"}
            onChange={(e) => setProjectId(e.target.value)}
            className="absolute inset-0 cursor-pointer opacity-0"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {/* Celular: fijo sobre la barra de navegación (el fondo llega hasta abajo para tapar el contenido). */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-[#1a1e28] bg-background px-5 pb-[104px] pt-3 sm:static sm:border-0 sm:bg-transparent sm:p-0">
        <div className="mx-auto max-w-xl space-y-2">
          <button
            onClick={source === "link" && !file ? () => onImportClick("clips") : onCreateClips}
            disabled={source === "link" && !file ? !link.trim() || importing : !file || confirmed || phase === "error"}
            className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-accent text-[17px] font-bold text-on-accent transition hover:brightness-105 disabled:opacity-50"
          >
            {confirmed ? (phase === "uploading" ? "Empieza al terminar la subida" : "Empezando…") : "Crear clips"}
          </button>
          <p className="text-center text-xs text-muted">
            {source === "link" && !file
              ? "Lo procesamos nosotros: puedes cerrar la página cuando empiece."
              : file && phase === "uploading"
                ? "No bloquees el celular hasta que termine de subir."
                : "Puedes cerrar la página cuando empiece el procesamiento."}
          </p>
        </div>
      </div>

      {askRights ? (
        <RightsDialog
          url={link}
          busy={importing}
          action={importMode === "download" ? "descargar" : "importar"}
          onCancel={() => setAskRights(false)}
          onConfirm={onConfirmImport}
        />
      ) : null}
    </div>
  );
}
