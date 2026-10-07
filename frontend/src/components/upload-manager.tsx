"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { SubtitleStyle, VideoDto } from "@clipflow/shared";
import { errorMessage } from "@/i18n/locale";
import { useT } from "@/i18n/provider";
import { apiFetch } from "@/lib/api";
import { uploadVideo, type UploadProgress } from "@/lib/uploader";
import { CheckIcon, UploadIcon } from "./icons";

export type UploadPhase = "uploading" | "uploaded" | "starting" | "done" | "error";
export type ClipChoices = { clipDurationSeconds: number; subtitleStyle: SubtitleStyle };

export interface UploadState {
  file: File;
  videoSeconds: number | null;
  phase: UploadPhase;
  progress: UploadProgress;
  error: string;
  /** El usuario ya apretó "Crear clips": el procesamiento empieza solo al terminar la subida. */
  confirmed: boolean;
  /** Video creado (al terminar, para ir a verlo). */
  videoId: string | null;
}

interface UploadManager {
  upload: UploadState | null;
  start(file: File, videoSeconds: number | null, projectId: () => Promise<string>): void;
  confirm(choices: ClipChoices): void;
  cancel(): Promise<void>;
  /** Olvida una subida terminada o fallida. */
  clear(): void;
}

const UploadContext = createContext<UploadManager | null>(null);

export function useUpload(): UploadManager {
  const ctx = useContext(UploadContext);
  if (!ctx) throw new Error("useUpload fuera de UploadProvider");
  return ctx;
}

/** Ruta de la pantalla de subir video. */
export const UPLOAD_PATH = "/dashboard/subir";

/**
 * Subida en segundo plano: vive en el layout del panel, así que sigue subiendo mientras el usuario
 * se mueve por la app (Mis videos, Cuenta…). Solo se corta si cierra o recarga la pestaña; por eso,
 * mientras sube, el navegador avisa antes de cerrar y se pide que la pantalla no se apague.
 */
export function UploadProvider({ children }: { children: ReactNode }) {
  const [upload, setUpload] = useState<UploadState | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const videoRef = useRef<VideoDto | null>(null);
  // "Crear clips" resuelve esta promesa; la subida la espera antes de confirmar.
  const confirmRef = useRef<((choices: ClipChoices) => void) | null>(null);
  const patch = (changes: Partial<UploadState>) => setUpload((u) => (u ? { ...u, ...changes } : u));

  const start = useCallback((file: File, videoSeconds: number | null, projectId: () => Promise<string>) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    videoRef.current = null;
    setUpload({ file, videoSeconds, phase: "uploading", progress: { uploadedBytes: 0, totalBytes: file.size }, error: "", confirmed: false, videoId: null });
    const confirmation = new Promise<ClipChoices>((resolve) => {
      confirmRef.current = resolve;
    });
    void (async () => {
      try {
        const project = await projectId();
        const video = await uploadVideo({
          file,
          projectId: project,
          durationSeconds: videoSeconds,
          signal: controller.signal,
          onProgress: (progress) => !controller.signal.aborted && patch({ progress }),
          onCreated: (v) => (videoRef.current = v),
          onUploaded: () => setUpload((u) => (u && u.phase === "uploading" ? { ...u, phase: u.confirmed ? "starting" : "uploaded" } : u)),
          completeWith: () => confirmation,
        });
        if (!controller.signal.aborted) patch({ phase: "done", videoId: video.id });
      } catch (err) {
        if (controller.signal.aborted) return;
        patch({ phase: "error", error: errorMessage(err) });
        // Libera la subida en S3 para no dejar partes huérfanas. (El tipo se fuerza: TS no ve la
        // asignación que hace onCreated dentro de la subida.)
        const created = videoRef.current as VideoDto | null;
        if (created) await apiFetch(`/videos/${created.id}/abort`, { method: "POST" }).catch(() => undefined);
      }
    })();
  }, []);

  const confirm = useCallback((choices: ClipChoices) => {
    setUpload((u) => (u ? { ...u, confirmed: true, phase: u.phase === "uploaded" ? "starting" : u.phase } : u));
    confirmRef.current?.(choices);
  }, []);

  const cancel = useCallback(async () => {
    abortRef.current?.abort();
    const created = videoRef.current;
    setUpload(null);
    if (created) await apiFetch(`/videos/${created.id}/abort`, { method: "POST" }).catch(() => undefined);
  }, []);

  const clear = useCallback(() => setUpload(null), []);

  // Mientras sube: avisa antes de cerrar la pestaña y evita que la pantalla se apague
  // (en el celular, con la pantalla bloqueada el navegador pausa la subida).
  const active = upload !== null && (upload.phase === "uploading" || upload.phase === "uploaded" || upload.phase === "starting");
  useEffect(() => {
    if (!active) return;
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
  }, [active]);

  return (
    <UploadContext.Provider value={{ upload, start, confirm, cancel, clear }}>
      {children}
      <UploadDock />
    </UploadContext.Provider>
  );
}

/** Barra flotante con la subida en curso, en cualquier pantalla del panel menos la de subir. */
function UploadDock() {
  const t = useT();
  const path = usePathname();
  const { upload, clear } = useUpload();
  if (!upload || path === UPLOAD_PATH) return null;
  const percent = upload.progress.totalBytes > 0 ? Math.floor((upload.progress.uploadedBytes / upload.progress.totalBytes) * 100) : 0;
  const done = upload.phase === "done" && upload.videoId;
  // Terminada: al video. Sin confirmar o con error: a la pantalla de subir (opciones o reintentar).
  const href = done ? `/dashboard/videos/${upload.videoId}` : UPLOAD_PATH;
  const status =
    upload.phase === "error"
      ? t.upload.stopped
      : done
        ? t.upload.dockDone
        : upload.phase === "uploading"
          ? upload.confirmed
            ? t.upload.uploading(percent)
            : t.upload.dockChoose(percent)
          : upload.confirmed
            ? t.upload.starting
            : t.upload.dockUploaded;
  return (
    <Link
      href={href}
      // Al abrir el video terminado, la barra ya no hace falta.
      onClick={() => done && setTimeout(clear, 0)}
      className="fixed inset-x-4 bottom-[104px] z-30 flex items-center gap-3 rounded-2xl border border-line bg-surface/95 p-3 shadow-lg backdrop-blur sm:inset-x-auto sm:bottom-6 sm:right-6 sm:w-80"
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#1d2433] text-accent">
        {done ? <CheckIcon size={20} strokeWidth={2.6} /> : <UploadIcon size={18} />}
      </span>
      <span className="min-w-0 flex-1 space-y-1">
        <span className="block truncate text-sm font-semibold">{upload.file.name}</span>
        <span className="block text-xs text-muted">{status}</span>
        {upload.phase === "uploading" ? (
          <span className="block h-1 overflow-hidden rounded-full bg-line">
            <span className="block h-full rounded-full bg-accent transition-all" style={{ width: `${percent}%` }} />
          </span>
        ) : null}
      </span>
    </Link>
  );
}
