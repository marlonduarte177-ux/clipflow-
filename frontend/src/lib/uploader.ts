import type { CreateVideoResponse, UploadPartUrlsResponse, VideoDto } from "@clipflow/shared";
import { apiFetch, ApiError } from "./api";

/** Partes que se suben al mismo tiempo. */
const CONCURRENCY = 3;
/** URLs que se piden a la API por lote (caducan: no se piden todas de golpe). */
const URL_BATCH = 20;
const MAX_ATTEMPTS = 4;

export interface UploadProgress {
  uploadedBytes: number;
  totalBytes: number;
}

export interface UploadOptions {
  file: File;
  projectId: string;
  durationSeconds: number | null;
  onProgress: (p: UploadProgress) => void;
  /** Se llama en cuanto existe el video (para poder cancelar). */
  onCreated?: (video: VideoDto) => void;
  signal: AbortSignal;
}

function putPart(url: string, blob: Blob, onLoaded: (bytes: number) => void, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => onLoaded(e.loaded);
    xhr.onload = () => {
      const etag = xhr.getResponseHeader("ETag");
      if (xhr.status >= 200 && xhr.status < 300 && etag) resolve(etag);
      else reject(new Error(`S3 respondió ${xhr.status}${etag ? "" : " sin ETag"}`));
    };
    xhr.onerror = () => reject(new Error("Error de red"));
    xhr.onabort = () => reject(new DOMException("Cancelado", "AbortError"));
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(blob);
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sube un video directo a S3 en partes:
 * pide a la API que abra la subida, sube cada parte con una URL firmada
 * (3 a la vez, con reintentos) y al final pide a la API que la confirme.
 */
export async function uploadVideo(options: UploadOptions): Promise<VideoDto> {
  const { file, signal } = options;
  const created = await apiFetch<CreateVideoResponse>("/videos", {
    method: "POST",
    body: {
      projectId: options.projectId,
      filename: file.name,
      sizeBytes: file.size,
      mimeType: file.type,
      durationSeconds: options.durationSeconds,
    },
    signal,
  });
  const video = created.video;
  options.onCreated?.(video);
  const { partSizeBytes, partCount } = created.upload;

  const loadedByPart = new Map<number, number>();
  const report = () =>
    options.onProgress({
      uploadedBytes: [...loadedByPart.values()].reduce((a, b) => a + b, 0),
      totalBytes: file.size,
    });

  const urlCache = new Map<number, string>();
  async function urlFor(partNumber: number, refresh = false): Promise<string> {
    if (!refresh && urlCache.has(partNumber)) return urlCache.get(partNumber)!;
    const batch = Array.from({ length: URL_BATCH }, (_, i) => partNumber + i).filter((n) => n <= partCount);
    const res = await apiFetch<UploadPartUrlsResponse>(`/videos/${video.id}/upload-parts`, {
      method: "POST",
      body: { partNumbers: refresh ? [partNumber] : batch },
      signal,
    });
    for (const { partNumber: n, url } of res.urls) urlCache.set(n, url);
    return urlCache.get(partNumber)!;
  }

  const etags = new Map<number, string>();
  let next = 1;
  async function worker() {
    while (next <= partCount) {
      const partNumber = next++;
      const start = (partNumber - 1) * partSizeBytes;
      const blob = file.slice(start, Math.min(start + partSizeBytes, file.size));
      for (let attempt = 1; ; attempt++) {
        try {
          const url = await urlFor(partNumber, attempt > 1);
          const etag = await putPart(url, blob, (b) => (loadedByPart.set(partNumber, b), report()), signal);
          etags.set(partNumber, etag);
          loadedByPart.set(partNumber, blob.size);
          report();
          break;
        } catch (err) {
          if (signal.aborted || (err as Error).name === "AbortError") throw err;
          if (err instanceof ApiError || attempt >= MAX_ATTEMPTS) throw err;
          loadedByPart.set(partNumber, 0);
          report();
          await wait(1000 * 2 ** (attempt - 1));
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, partCount) }, worker));

  return apiFetch<VideoDto>(`/videos/${video.id}/complete`, {
    method: "POST",
    body: { parts: [...etags].map(([partNumber, etag]) => ({ partNumber, etag })) },
    signal,
  });
}

/** Duración del video leída en el navegador (null si el navegador no puede leerla). */
export function readVideoDuration(file: File, timeoutMs = 8000): Promise<number | null> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    const done = (value: number | null) => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      video.removeAttribute("src");
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    video.preload = "metadata";
    video.onloadedmetadata = () => done(Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null);
    video.onerror = () => done(null);
    video.src = url;
  });
}
