"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  checkImportUrl,
  translateMessage,
  DEFAULT_PRODUCT_CONFIG,
  FEATURES,
  RANGE_PICKER_MIN_VIDEO_SECONDS,
  resolveVideoMimeType,
  type BillingResponse,
  type ImportVideoResponse,
  type LinkPreview,
  type ProjectDto,
  type ProjectListResponse,
  type SubtitleStyle,
  type VideoDto,
} from "@clipflow/shared";
import { DEFAULT_DURATION, DurationPicker, SubtitlePicker } from "@/components/clip-options";
import { CheckIcon, CloseIcon, DownIcon, DownloadIcon, LinesIcon, NextIcon, UploadIcon, VideosIcon } from "@/components/icons";
import { formatRangeTime, RangePicker, type VideoRange } from "@/components/range-picker";
import { Alert } from "@/components/ui";
import { errorMessage } from "@/i18n/locale";
import { useLocale, useT } from "@/i18n/provider";
import { apiConfigured, apiFetch, formatBytes, formatDuration } from "@/lib/api";
import { readVideoDuration, readVideoPoster, uploadVideo, type UploadProgress } from "@/lib/uploader";

// Límites mostrados al usuario; la API los vuelve a comprobar siempre.
const LIMITS = DEFAULT_PRODUCT_CONFIG.upload;

type Phase = "idle" | "uploading" | "uploaded" | "starting" | "error";

/**
 * Nuevo video, en 2 pasos:
 * 1. Identificar el video SIN bajarlo: al pegar un enlace sale su tarjeta (miniatura, título y
 *    duración, leídos de la plataforma); al elegir un archivo, la duración y un fotograma se leen en el
 *    navegador y la subida empieza sola. Debajo, el aviso de derechos y las opciones.
 * 2. «Duración del video» (solo videos de 10 min o más): elegir el tramo a procesar. Solo se baja y se
 *    cobra ese tramo.
 */
export function UploadView() {
  const t = useT();
  const { locale } = useLocale();
  const router = useRouter();
  const params = useSearchParams();
  const [projects, setProjects] = useState<ProjectDto[] | null>(null);
  const [projectId, setProjectId] = useState(params.get("projectId") ?? "");
  const [billing, setBilling] = useState<BillingResponse | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [poster, setPoster] = useState<string | null>(null);
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
  const [preview, setPreview] = useState<LinkPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  // Tramo elegido en «Duración del video» (null: el video completo).
  const [range, setRange] = useState<VideoRange | null>(null);
  const [picking, setPicking] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const videoRef = useRef<VideoDto | null>(null);
  // "Crear clips" resuelve esta promesa; la subida la espera antes de confirmar.
  const confirmRef = useRef<((options: { clipDurationSeconds: number; subtitleStyle: SubtitleStyle; rangeStartSeconds?: number; rangeEndSeconds?: number }) => void) | null>(null);

  useEffect(() => {
    if (!apiConfigured) return;
    apiFetch<ProjectListResponse>("/projects")
      .then((r) => {
        setProjects(r.projects);
        setProjectId((current) => current || r.projects[0]?.id || "");
      })
      .catch((err: Error) => setError(errorMessage(err)));
    // Minutos del plan: para avisar en «Duración del video» si el tramo no alcanza.
    apiFetch<BillingResponse>("/billing")
      .then(setBilling)
      .catch(() => undefined);
  }, []);

  // Paso 1 con enlace: la tarjeta sale sola al pegarlo (sin bajar el video).
  const linkReady = source === "link" && checkImportUrl(link.trim()).ok;
  useEffect(() => {
    const raw = link.trim();
    if (!linkReady) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      apiFetch<{ preview: LinkPreview | null }>("/videos/preview", { method: "POST", body: { url: raw } })
        .then((r) => !cancelled && setPreview(r.preview))
        .catch((err: Error) => !cancelled && setError(errorMessage(err)))
        .finally(() => !cancelled && setPreviewLoading(false));
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [link, linkReady]);

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
    // La duración se lee en el navegador, antes de subir.
    const seconds = await readVideoDuration(selected);
    if (seconds && seconds > LIMITS.maxDurationSeconds) {
      setError(t.upload.tooLong(formatDuration(seconds), formatDuration(LIMITS.maxDurationSeconds)));
      return;
    }
    setFile(selected);
    setVideoSeconds(seconds);
    setRange(null);
    setPoster(null);
    void readVideoPoster(selected).then(setPoster);
    void start(selected, seconds);
  }

  async function start(selected: File, seconds: number | null) {
    const controller = new AbortController();
    abortRef.current = controller;
    videoRef.current = null;
    setConfirmed(false);
    setPhase("uploading");
    setProgress({ uploadedBytes: 0, totalBytes: selected.size });
    const confirmation = new Promise<{ clipDurationSeconds: number; subtitleStyle: SubtitleStyle; rangeStartSeconds?: number; rangeEndSeconds?: number }>((resolve) => {
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

  const rangeBody = range ? { rangeStartSeconds: range.startSeconds, rangeEndSeconds: range.endSeconds } : {};

  // Al continuar, el usuario confirma que tiene derechos (el aviso está debajo de la tarjeta).
  async function onImport(mode: "clips" | "download") {
    const checked = checkImportUrl(link);
    if (!checked.ok) {
      setError(translateMessage(checked.message, locale));
      return;
    }
    setError("");
    setImporting(true);
    try {
      const project = await ensureProject();
      const { video } = await apiFetch<ImportVideoResponse>("/videos/import", {
        method: "POST",
        body:
          mode === "download"
            ? { projectId: project, url: link.trim(), rightsConfirmed: true, downloadOnly: true }
            : { projectId: project, url: link.trim(), rightsConfirmed: true, clipDurationSeconds: clipSeconds, subtitleStyle, ...rangeBody },
      });
      router.push(`/dashboard/videos/${video.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setImporting(false);
    }
  }

  function onCreateClips() {
    setConfirmed(true);
    setPhase((p) => (p === "uploaded" ? "starting" : p));
    confirmRef.current?.({ clipDurationSeconds: clipSeconds, subtitleStyle, ...rangeBody });
  }

  async function onCancel() {
    abortRef.current?.abort();
    const created = videoRef.current;
    setFile(null);
    setPoster(null);
    setVideoSeconds(null);
    setRange(null);
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
  const isLink = source === "link" && !file;
  // Lo que se sabe del video elegido (tarjeta del paso 1).
  const totalSeconds = isLink ? (preview?.durationSeconds ?? null) : videoSeconds;
  const thumbnail = isLink ? (preview?.thumbnailUrl ?? null) : poster;
  const identified = isLink ? preview !== null : file !== null;
  const canPickRange = totalSeconds !== null && totalSeconds >= RANGE_PICKER_MIN_VIDEO_SECONDS && !confirmed;
  const availableMinutes = billing?.enabled && !billing.exempt ? billing.creditMinutes : null;

  return (
    <div className="mx-auto max-w-xl space-y-6 pb-24 sm:pb-0">
      <div className="space-y-1.5">
        <h1 className="text-[28px] font-bold tracking-tight">{t.upload.title}</h1>
        <p className="text-sm text-muted">{file ? t.upload.subtitleFile : t.upload.subtitle}</p>
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

      {isLink ? (
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
              // Otro enlace: otra tarjeta (y otro tramo).
              setPreview(null);
              setRange(null);
              setPreviewLoading(checkImportUrl(e.target.value.trim()).ok);
            }}
            placeholder="https://kick.com/…/videos/…"
            className="h-12 w-full rounded-xl border border-line bg-background px-3.5 text-base outline-none focus:border-accent"
          />
          {!preview && !previewLoading ? <p className="text-xs leading-[17px] text-muted">{t.upload.linkHint(formatDuration(LIMITS.maxDurationSeconds))}</p> : null}
        </div>
      ) : !file ? (
        <label className="flex cursor-pointer flex-col items-center gap-3 rounded-[22px] border-2 border-dashed border-[#2b3140] bg-surface px-6 py-10 text-center transition hover:border-accent">
          <span className="grid h-14 w-14 place-items-center rounded-[18px] bg-accent text-on-accent">
            <UploadIcon size={26} strokeWidth={2.4} />
          </span>
          <span className="text-base font-semibold">{t.upload.choose}</span>
          <span className="text-xs text-muted">{t.upload.limits(formatBytes(LIMITS.maxBytes), formatDuration(LIMITS.maxDurationSeconds))}</span>
          <input type="file" accept="video/mp4,video/quicktime,video/webm,video/x-matroska,.mkv" onChange={onFile} className="sr-only" />
        </label>
      ) : null}

      {/* Paso 1: la tarjeta del video. */}
      {isLink && previewLoading && !preview ? <VideoCardSkeleton label={t.upload.reading} /> : null}
      {identified ? (
        <div className="space-y-3">
          <div className="overflow-hidden rounded-[22px] border border-line bg-surface animate-[card-in_220ms_ease-out]">
            <div className="relative aspect-video w-full bg-[#161a23]">
              {thumbnail ? (
                // eslint-disable-next-line @next/next/no-img-element -- miniatura de la plataforma o fotograma leído en el navegador
                <img src={thumbnail} alt="" className="h-full w-full object-cover" />
              ) : (
                <div className="grid h-full w-full place-items-center text-[#3a4256]">
                  <VideosIcon size={44} />
                </div>
              )}
              <span className="absolute bottom-2.5 right-2.5 rounded-lg bg-black/75 px-2 py-1 text-xs font-semibold tabular-nums text-white backdrop-blur-sm">
                {totalSeconds ? formatDuration(totalSeconds) : t.upload.durationUnknown}
              </span>
              {file ? (
                <button
                  onClick={onCancel}
                  aria-label={t.upload.cancelUpload}
                  disabled={phase === "starting" || confirmed}
                  className="absolute right-2.5 top-2.5 grid h-10 w-10 place-items-center rounded-full bg-black/60 text-white backdrop-blur-sm disabled:hidden"
                >
                  <CloseIcon size={18} />
                </button>
              ) : null}
            </div>
            <div className="space-y-1.5 p-3.5">
              <p className="line-clamp-2 text-[15px] font-semibold leading-snug">{isLink ? (preview?.title ?? link.trim()) : file!.name}</p>
              <p className="text-[13px] text-muted">
                {isLink ? preview!.platform : `${formatBytes(file!.size)}${videoSeconds ? ` · ${formatDuration(videoSeconds)}` : ""}`}
              </p>
              {file ? (
                <div className="space-y-1.5 pt-1">
                  <div className="h-1.5 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label={t.upload.ariaUpload}>
                    <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${percent}%` }} />
                  </div>
                  <p className="flex items-center gap-1.5 text-xs text-muted">
                    {phase === "uploaded" || phase === "starting" ? <CheckIcon size={14} strokeWidth={2.6} className="text-accent" /> : null}
                    {phase === "uploading" ? t.upload.uploading(percent) : phase === "error" ? t.upload.stopped : t.upload.uploaded}
                  </p>
                </div>
              ) : null}
            </div>
          </div>
          <p className="px-1 text-center text-xs leading-[17px] text-muted">{t.upload.rightsContinue}</p>
        </div>
      ) : source === "file" && !file ? (
        <p className="-mt-3 text-center text-xs text-muted">{t.upload.rightsNote}</p>
      ) : null}

      <Alert kind="error">{error}</Alert>

      {/* Opciones. La primera fila: qué parte del video procesar. */}
      <button
        type="button"
        onClick={() => setPicking(true)}
        disabled={!canPickRange}
        className="flex min-h-[56px] w-full items-center justify-between gap-3 rounded-2xl border border-line bg-surface px-4 text-left transition enabled:hover:border-[#3a4256] enabled:active:scale-[0.99]"
      >
        <span className="text-[15px] font-semibold">{t.upload.videoDuration}</span>
        <span className="flex items-center gap-1.5 text-sm font-semibold tabular-nums text-muted">
          <span className={range ? "text-foreground" : ""}>
            {range ? `${formatRangeTime(range.startSeconds)} - ${formatRangeTime(range.endSeconds)}` : t.upload.full}
          </span>
          {canPickRange ? <NextIcon size={18} /> : null}
        </span>
      </button>

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
          <div className="flex gap-2">
            {/* Otra acción con el mismo enlace: bajar el video tal cual, sin clips (si está activada). */}
            {isLink && FEATURES.downloadOnly ? (
              <button
                type="button"
                onClick={() => onImport("download")}
                disabled={!preview || importing}
                aria-label={t.upload.downloadOnly}
                className="flex h-14 shrink-0 items-center justify-center gap-2 rounded-2xl border border-accent/50 px-4 text-[15px] font-semibold text-accent transition hover:bg-accent/10 disabled:opacity-40"
              >
                <DownloadIcon size={18} strokeWidth={2.4} />
                {t.upload.downloadOnly}
              </button>
            ) : null}
            <button
              onClick={isLink ? () => onImport("clips") : onCreateClips}
              disabled={isLink ? !preview || importing : !file || confirmed || phase === "error"}
              className="flex h-14 flex-1 items-center justify-center gap-2 rounded-2xl bg-accent text-[17px] font-bold text-on-accent transition hover:brightness-105 disabled:opacity-50"
            >
              {confirmed ? (phase === "uploading" ? t.upload.startsAfterUpload : t.upload.starting) : t.common.createClips}
            </button>
          </div>
          <p className="text-center text-xs text-muted">{isLink ? t.upload.linkFooter : file && phase === "uploading" ? t.upload.keepAwake : t.upload.canClose}</p>
        </div>
      </div>

      {/* Paso 2: «Duración del video». */}
      {picking && totalSeconds ? (
        <RangePicker
          durationSeconds={totalSeconds}
          value={range}
          thumbnailUrl={thumbnail}
          availableMinutes={availableMinutes}
          onCancel={() => setPicking(false)}
          onConfirm={(r) => {
            setRange(r);
            setPicking(false);
          }}
        />
      ) : null}
    </div>
  );
}

/** Mientras se leen los datos del enlace (menos de 3 s). */
function VideoCardSkeleton({ label }: { label: string }) {
  return (
    <div className="overflow-hidden rounded-[22px] border border-line bg-surface" aria-busy="true" aria-label={label}>
      <div className="aspect-video w-full animate-pulse bg-[#161a23]" />
      <div className="space-y-2 p-3.5">
        <div className="h-4 w-4/5 animate-pulse rounded bg-[#1d2230]" />
        <div className="h-3 w-1/3 animate-pulse rounded bg-[#1d2230]" />
      </div>
    </div>
  );
}
