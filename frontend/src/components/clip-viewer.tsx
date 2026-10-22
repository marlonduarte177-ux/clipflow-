"use client";

import { useEffect, useRef, useState } from "react";
import type { ClipDto } from "@clipflow/shared";
import { BackIcon, CheckIcon, CloseIcon, DownloadIcon, LinesIcon, NextIcon, RetryIcon, ShareIcon, SubtitlesIcon, TrashIcon } from "./icons";
import { CopyTextButton, CueList, LanguageBadge, useCues } from "./transcript";
import { errorMessage } from "@/i18n/locale";
import { useT } from "@/i18n/provider";
import { apiFetch } from "@/lib/api";
import { shareVideoFile } from "@/lib/share";
import { clock } from "@/lib/vtt";

export const scoreOf = (clip: ClipDto) => (clip.score == null ? null : Math.round(clip.score * 100));

/**
 * Vista de un clip a pantalla completa (celular) o como ventana (computadora):
 * reproductor, descargar, compartir, aprobar/descartar, subtítulos .srt y transcripción.
 */
export function ClipViewer({
  clips,
  index,
  titleOf,
  language,
  onIndex,
  onClose,
  onStatus,
  onShowFullTranscript,
  onError,
}: {
  clips: ClipDto[];
  index: number;
  /** Título del clip (o "Clip N" si no tiene). */
  titleOf: (clip: ClipDto) => string;
  language: string | null;
  onIndex: (index: number) => void;
  onClose: () => void;
  onStatus: (clip: ClipDto, status: ClipDto["status"]) => void;
  onShowFullTranscript?: () => void;
  onError: (message: string) => void;
}) {
  const t = useT();
  const clip = clips[index]!;
  const videoRef = useRef<HTMLVideoElement>(null);
  const [time, setTime] = useState(0);
  const [busy, setBusy] = useState<"download" | "share" | null>(null);
  const [note, setNote] = useState("");
  const { cues, failed } = useCues(clip.subtitlesVttUrl);
  const touchX = useRef<number | null>(null);
  const hasPrev = index > 0;
  const hasNext = index < clips.length - 1;

  // Teclado (computadora): Esc cierra, flechas cambian de clip. La página de atrás no se desplaza.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight" && hasNext) onIndex(index + 1);
      if (e.key === "ArrowLeft" && hasPrev) onIndex(index - 1);
    };
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [index, hasNext, hasPrev, onClose, onIndex]);

  async function download() {
    setBusy("download");
    try {
      const { url } = await apiFetch<{ url: string }>(`/clips/${clip.id}/download`);
      window.location.href = url;
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function share() {
    if (!clip.videoUrl) return;
    setBusy("share");
    setNote("");
    try {
      const result = await shareVideoFile(clip.videoUrl, `clipflow-${Math.round(clip.startSeconds)}s.mp4`, titleOf(clip));
      if (result === "unsupported") setNote(t.common.shareUnsupported);
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const seek = (seconds: number) => {
    if (!videoRef.current) return;
    videoRef.current.currentTime = seconds;
    void videoRef.current.play().catch(() => undefined);
  };
  const score = scoreOf(clip);

  return (
    <div role="dialog" aria-modal="true" aria-label={titleOf(clip)} className="fixed inset-0 z-50 flex justify-center bg-black/80 sm:items-center sm:p-6">
      <div className="flex h-full w-full max-w-[440px] flex-col overflow-y-auto bg-black sm:h-auto sm:max-h-full sm:rounded-[28px] sm:border sm:border-line">
        <div
          className="relative shrink-0 bg-[#11141b]"
          onTouchStart={(e) => (touchX.current = e.touches[0]?.clientX ?? null)}
          onTouchEnd={(e) => {
            const start = touchX.current;
            const end = e.changedTouches[0]?.clientX;
            touchX.current = null;
            if (start == null || end == null || Math.abs(end - start) < 70) return;
            if (end < start && hasNext) onIndex(index + 1);
            if (end > start && hasPrev) onIndex(index - 1);
          }}
        >
          {clip.videoUrl ? (
            <video
              key={clip.id}
              ref={videoRef}
              src={clip.videoUrl}
              poster={clip.thumbnailUrl ?? undefined}
              controls
              playsInline
              preload="metadata"
              onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
              className="mx-auto aspect-[9/16] max-h-[68vh] w-full bg-black object-contain sm:max-h-[60vh]"
            />
          ) : (
            <div className="grid aspect-[9/16] max-h-[68vh] w-full place-items-center text-sm text-muted">{t.clip.unavailable}</div>
          )}
          <div className="pointer-events-none absolute inset-x-3 top-3 flex items-center justify-between">
            <button onClick={onClose} aria-label={t.common.close} className="pointer-events-auto grid h-11 w-11 place-items-center rounded-full bg-black/55 text-white">
              <CloseIcon size={18} strokeWidth={2.2} />
            </button>
            <span className="rounded-full bg-black/55 px-3 py-1.5 text-[13px] font-semibold text-white">
              {t.clip.position(index + 1, clips.length)}
            </span>
            {score != null ? (
              <span className="rounded-full bg-accent px-3 py-1.5 text-[13px] font-bold text-on-accent" title={t.clip.scoreHint}>
                {score}
              </span>
            ) : (
              <span />
            )}
          </div>
        </div>

        <div className="-mt-4 flex flex-1 flex-col gap-4 rounded-t-3xl bg-background px-5 pb-6 pt-5 sm:rounded-b-[28px]">
          <div className="space-y-1">
            <h2 className="text-[19px] font-bold leading-6 tracking-tight">{titleOf(clip)}</h2>
            <p className="text-[13px] text-muted">
              {t.clip.range(clock(clip.startSeconds), clock(clip.endSeconds), Math.round(clip.endSeconds - clip.startSeconds))}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <button onClick={download} disabled={busy !== null} className="flex h-[54px] items-center justify-center gap-2 rounded-2xl bg-accent text-base font-bold text-on-accent disabled:opacity-60">
              <DownloadIcon size={20} strokeWidth={2.4} />
              {busy === "download" ? t.common.preparing : t.common.download}
            </button>
            <button onClick={share} disabled={busy !== null || !clip.videoUrl} className="flex h-[54px] items-center justify-center gap-2 rounded-2xl border border-[#2a3040] bg-surface text-base font-semibold disabled:opacity-60">
              <ShareIcon size={20} />
              {busy === "share" ? t.common.preparing : t.common.share}
            </button>
          </div>
          <p className="-mt-2 text-xs text-muted">{note || t.clip.shareHint}</p>

          <div className="grid grid-cols-3 gap-2">
            {clip.status === "approved" ? (
              <button onClick={() => onStatus(clip, "generated")} className="flex h-16 flex-col items-center justify-center gap-1 rounded-[14px] border border-accent bg-[#161b12] text-xs text-accent">
                <CheckIcon size={20} />
                {t.clip.approved}
              </button>
            ) : (
              <button onClick={() => onStatus(clip, "approved")} className="flex h-16 flex-col items-center justify-center gap-1 rounded-[14px] border border-line bg-surface text-xs">
                <CheckIcon size={20} />
                {t.clip.approve}
              </button>
            )}
            {clip.status === "discarded" ? (
              <button onClick={() => onStatus(clip, "generated")} className="flex h-16 flex-col items-center justify-center gap-1 rounded-[14px] border border-line bg-surface text-xs">
                <RetryIcon size={20} />
                {t.clip.restore}
              </button>
            ) : (
              <button onClick={() => onStatus(clip, "discarded")} className="flex h-16 flex-col items-center justify-center gap-1 rounded-[14px] border border-line bg-surface text-xs">
                <TrashIcon size={20} />
                {t.clip.discard}
              </button>
            )}
            {clip.subtitlesSrtUrl ? (
              <a href={clip.subtitlesSrtUrl} className="flex h-16 flex-col items-center justify-center gap-1 rounded-[14px] border border-line bg-surface text-xs">
                <SubtitlesIcon size={20} />
                {t.clip.srt}
              </a>
            ) : (
              <span className="flex h-16 flex-col items-center justify-center gap-1 rounded-[14px] border border-line bg-surface text-xs text-muted">
                <SubtitlesIcon size={20} />
                {t.clip.noSubtitles}
              </span>
            )}
          </div>

          {clip.subtitlesVttUrl ? (
            <section aria-labelledby="transcripcion" className="space-y-2.5 rounded-[18px] border border-line bg-surface px-3 pb-3.5 pt-4">
              <div className="flex items-center justify-between gap-2 px-1">
                <h3 id="transcripcion" className="text-base font-bold">
                  {t.clip.transcript}
                </h3>
                {language ? <LanguageBadge name={language} /> : null}
              </div>
              <p className="px-1 text-xs leading-[17px] text-muted">
                {t.clip.transcriptHint}
              </p>
              {cues ? (
                <CueList cues={cues} current={time} onSeek={seek} />
              ) : (
                <p className="px-1 text-sm text-muted">{failed ? t.clip.transcriptFailed : t.common.loading}</p>
              )}
              <div className="grid grid-cols-2 gap-2 px-1 pt-1">
                {cues ? <CopyTextButton cues={cues} /> : <span />}
                {onShowFullTranscript ? (
                  <button onClick={onShowFullTranscript} className="flex h-11 items-center justify-center gap-1.5 rounded-xl border border-[#2a3040] bg-background text-[13px] font-semibold">
                    <LinesIcon size={16} />
                    {t.clip.fullVideo}
                  </button>
                ) : null}
              </div>
            </section>
          ) : null}

          <div className="mt-auto flex items-center justify-between pt-2">
            <button onClick={() => onIndex(index - 1)} disabled={!hasPrev} aria-label={t.clip.previous} className="grid h-11 w-11 place-items-center rounded-full border border-line bg-surface disabled:text-[#3a4256]">
              <BackIcon size={20} />
            </button>
            <span className="text-[13px] text-muted">{t.clip.swipe}</span>
            <button onClick={() => onIndex(index + 1)} disabled={!hasNext} aria-label={t.clip.next} className="grid h-11 w-11 place-items-center rounded-full border border-line bg-surface disabled:text-[#3a4256]">
              <NextIcon size={20} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Transcripción completa del video, en una hoja aparte. */
export function FullTranscript({ url, language, onClose }: { url: string; language: string | null; onClose: () => void }) {
  const t = useT();
  const { cues, failed } = useCues(url);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div role="dialog" aria-modal="true" aria-label={t.clip.fullTranscript} className="fixed inset-0 z-[60] flex justify-center bg-black/80 sm:items-center sm:p-6">
      <div className="flex h-full w-full max-w-[560px] flex-col bg-background sm:h-[85vh] sm:rounded-[28px] sm:border sm:border-line">
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <button onClick={onClose} aria-label={t.common.back} className="grid h-11 w-11 place-items-center rounded-full">
            <BackIcon size={22} />
          </button>
          <h2 className="flex-1 text-base font-bold">{t.clip.fullTranscript}</h2>
          {language ? <LanguageBadge name={language} /> : null}
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-3">
          {cues ? <CueList cues={cues} /> : <p className="p-3 text-sm text-muted">{failed ? t.clip.transcriptFailed : t.common.loading}</p>}
        </div>
        {cues ? (
          <div className="grid border-t border-line p-4 pb-[max(16px,env(safe-area-inset-bottom))]">
            <CopyTextButton cues={cues} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
