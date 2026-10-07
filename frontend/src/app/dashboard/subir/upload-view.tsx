"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  checkImportUrl,
  translateMessage,
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
import { errorMessage } from "@/i18n/locale";
import { useLocale, useT } from "@/i18n/provider";
import { apiConfigured, apiFetch, formatBytes, formatDuration } from "@/lib/api";
import { parseClock } from "@/lib/clock-input";
import { readVideoDuration, uploadVideo, type UploadProgress } from "@/lib/uploader";

// Límites mostrados al usuario; la API los vuelve a comprobar siempre.
const LIMITS = DEFAULT_PRODUCT_CONFIG.upload;
/** Parte mínima de un enlace (la API pide lo mismo). */
const MIN_RANGE_SECONDS = 30;

type Phase = "idle" | "uploading" | "uploaded" | "starting" | "error";

/**
 * Subir video: el archivo empieza a subirse apenas se elige y, mientras tanto, el usuario elige
 * la duración de los clips y el estilo de subtítulos. "Crear clips" confirma: si la subida no
 * terminó, el procesamiento empieza solo en cuanto termine.
 */
export function UploadView() {
  const t = useT();
  const { locale } = useLocale();
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
  /** Por enlace: usar solo una parte (p. ej. de un stream largo). */
  const [useRange, setUseRange] = useState(false);
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");

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
      .catch((err: Error) => setError(errorMessage(err)));
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
    const created = await apiFetch<ProjectDto>("/projects", { method: "POST", body: { name: t.upload.defaultProject } });
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
      setError(t.upload.unsupported);
      return;
    }
    if (selected.size > LIMITS.maxBytes) {
      setError(t.upload.tooBig(formatBytes(LIMITS.maxBytes)));
      return;
    }
    const seconds = await readVideoDuration(selected);
    if (seconds && seconds > LIMITS.maxDurationSeconds) {
      setError(t.upload.tooLong(formatDuration(seconds), formatDuration(LIMITS.maxDurationSeconds)));
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
      setError(errorMessage(err));
      setPhase("error");
      // Libera la subida en S3 para no dejar partes huérfanas. (El tipo se fuerza: TS no ve la
      // asignación que hace onCreated dentro de la subida.)
      const created = videoRef.current as VideoDto | null;
      if (created) await apiFetch(`/videos/${created.id}/abort`, { method: "POST" }).catch(() => undefined);
    }
  }

  /** La parte elegida del enlace: lo que se manda a la API y el texto que la explica, o un error. */
  function linkRange(): { ok: true; body: { startSeconds?: number; endSeconds?: number }; note: string } | { ok: false; message: string } {
    if (!useRange) return { ok: true, body: {}, note: "" };
    const from = parseClock(rangeFrom);
    const to = parseClock(rangeTo);
    if (Number.isNaN(from) || Number.isNaN(to)) return { ok: false, message: t.upload.rangeInvalid };
    const start = from ?? 0;
    const max = formatDuration(LIMITS.maxDurationSeconds);
    if (to === null) return { ok: true, body: { startSeconds: start }, note: t.upload.rangeToEnd(max) };
    if (to <= start) return { ok: false, message: t.upload.rangeOrder };
    if (to - start < MIN_RANGE_SECONDS) return { ok: false, message: t.upload.rangeTooShort };
    if (to - start > LIMITS.maxDurationSeconds) return { ok: false, message: t.upload.rangeTooLong(max) };
    return { ok: true, body: { startSeconds: start, endSeconds: to }, note: t.upload.rangeLength(formatDuration(to - start)) };
  }

  function onImportClick(mode: "clips" | "download") {
    const checked = checkImportUrl(link);
    if (!checked.ok) {
      setError(translateMessage(checked.message, locale));
      return;
    }
    const range = linkRange();
    if (!range.ok) {
      setError(range.message);
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
      const range = linkRange();
      const { video } = await apiFetch<ImportVideoResponse>("/videos/import", {
        method: "POST",
        body: {
          projectId: project,
          url: link.trim(),
          rightsConfirmed: true,
          ...(range.ok ? range.body : {}),
          ...(importMode === "download" ? { downloadOnly: true } : { clipDurationSeconds: clipSeconds, subtitleStyle }),
        },
      });
      router.push(`/dashboard/videos/${video.id}`);
    } catch (err) {
      setError(errorMessage(err));
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
    return <Alert kind="error">{t.common.apiNotConnected}</Alert>;
  }

  const percent = progress && progress.totalBytes > 0 ? Math.floor((progress.uploadedBytes / progress.totalBytes) * 100) : 0;
  const project = projects?.find((p) => p.id === projectId);

  return (
    <div className="mx-auto max-w-xl space-y-6 pb-24 sm:pb-0">
      <div className="space-y-1.5">
        <h1 className="text-[28px] font-bold tracking-tight">{t.upload.title}</h1>
        <p className="text-sm text-muted">
          {file ? t.upload.subtitleFile : t.upload.subtitle}
        </p>
      </div>

      {!file ? (
        <div role="tablist" aria-label={t.upload.source} className="grid grid-cols-2 gap-1 rounded-2xl border border-line bg-surface p-1">
          {(
            [
              ["file", t.upload.file],
              ["link", t.upload.link],
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
            {t.upload.linkLabel}
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
          <RangeFields
            enabled={useRange}
            onEnabled={(on) => {
              setUseRange(on);
              setError("");
            }}
            from={rangeFrom}
            to={rangeTo}
            onFrom={(v) => {
              setRangeFrom(v);
              setError("");
            }}
            onTo={(v) => {
              setRangeTo(v);
              setError("");
            }}
            note={(() => {
              const r = linkRange();
              return r.ok ? r.note : "";
            })()}
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
            {t.upload.downloadOnly}
          </button>
          ) : null}
          <p className="text-xs leading-[17px] text-muted">
            {t.upload.linkHint(formatDuration(LIMITS.maxDurationSeconds))}
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
            <div className="h-1.5 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label={t.upload.ariaUpload}>
              <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${percent}%` }} />
            </div>
            <p className="text-xs text-muted">
              {phase === "uploading" ? t.upload.uploading(percent) : phase === "error" ? t.upload.stopped : t.upload.uploaded}
            </p>
          </div>
          {phase === "uploading" || phase === "uploaded" || phase === "error" ? (
            <button onClick={onCancel} aria-label={t.upload.cancelUpload} className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-line text-muted hover:text-foreground">
              <CloseIcon size={18} />
            </button>
          ) : null}
        </div>
      ) : (
        <label className="flex cursor-pointer flex-col items-center gap-3 rounded-[22px] border-2 border-dashed border-[#2b3140] bg-surface px-6 py-10 text-center transition hover:border-accent">
          <span className="grid h-14 w-14 place-items-center rounded-[18px] bg-accent text-on-accent">
            <UploadIcon size={26} strokeWidth={2.4} />
          </span>
          <span className="text-base font-semibold">{t.upload.choose}</span>
          <span className="text-xs text-muted">
            {t.upload.limits(formatBytes(LIMITS.maxBytes), formatDuration(LIMITS.maxDurationSeconds))}
          </span>
          <input type="file" accept="video/mp4,video/quicktime,video/webm,video/x-matroska,.mkv" onChange={onFile} className="sr-only" />
        </label>
      )}
      {source === "file" && !file ? (
        <p className="-mt-3 text-center text-xs text-muted">{t.upload.rightsNote}</p>
      ) : null}

      <Alert kind="error">{error}</Alert>

      <DurationPicker value={clipSeconds} onChange={setClipSeconds} disabled={confirmed} />
      <SubtitlePicker value={subtitleStyle} onChange={setSubtitleStyle} disabled={confirmed} />

      {projects && projects.length > 0 ? (
        <label className="relative flex min-h-[52px] items-center justify-between gap-3 rounded-2xl border border-line bg-surface px-4">
          <span className="text-sm text-muted">{t.upload.project}</span>
          <span className="flex items-center gap-1.5 text-sm font-semibold">
            {project?.name ?? t.upload.chooseProject}
            <DownIcon size={16} />
          </span>
          <select
            aria-label={t.upload.project}
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
            {confirmed ? (phase === "uploading" ? t.upload.startsAfterUpload : t.upload.starting) : t.common.createClips}
          </button>
          <p className="text-center text-xs text-muted">
            {source === "link" && !file
              ? t.upload.linkFooter
              : file && phase === "uploading"
                ? t.upload.keepAwake
                : t.upload.canClose}
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

/** "Usar solo una parte del video": desde / hasta, escritos como 1:30:00. */
function RangeFields({
  enabled,
  onEnabled,
  from,
  to,
  onFrom,
  onTo,
  note,
}: {
  enabled: boolean;
  onEnabled: (on: boolean) => void;
  from: string;
  to: string;
  onFrom: (value: string) => void;
  onTo: (value: string) => void;
  note: string;
}) {
  const t = useT();
  const field = "h-11 w-full rounded-xl border border-line bg-background px-3 text-base tabular-nums outline-none focus:border-accent";
  return (
    <div className="space-y-2.5 rounded-xl border border-line/70 p-3">
      <label className="flex cursor-pointer items-center justify-between gap-3">
        <span className="text-sm font-semibold">{t.upload.rangeToggle}</span>
        <input type="checkbox" checked={enabled} onChange={(e) => onEnabled(e.target.checked)} className="h-5 w-5 accent-accent" />
      </label>
      <p className="text-xs leading-[17px] text-muted">{t.upload.rangeHint}</p>
      {enabled ? (
        <>
          <div className="grid grid-cols-2 gap-2.5">
            <label className="space-y-1">
              <span className="text-xs text-muted">{t.upload.rangeFrom}</span>
              <input value={from} onChange={(e) => onFrom(e.target.value)} placeholder="0:00:00" autoComplete="off" className={field} />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted">{t.upload.rangeTo}</span>
              <input value={to} onChange={(e) => onTo(e.target.value)} placeholder={t.upload.rangeToPlaceholder} autoComplete="off" className={field} />
            </label>
          </div>
          {note ? <p className="text-xs font-semibold text-accent">{note}</p> : null}
        </>
      ) : null}
    </div>
  );
}
