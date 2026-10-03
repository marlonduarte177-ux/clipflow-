"use client";

import { useEffect, useMemo, useState } from "react";
import { CopyIcon, GlobeIcon } from "./icons";
import { useT } from "@/i18n/provider";
import { clock, parseVtt, type Cue } from "@/lib/vtt";

/** Descarga y lee un WebVTT (URL temporal de S3). */
export function useCues(url: string | null | undefined): { cues: Cue[] | null; failed: boolean } {
  const [state, setState] = useState<{ url: string | null; cues: Cue[] | null; failed: boolean }>({
    url: null,
    cues: null,
    failed: false,
  });
  useEffect(() => {
    if (!url) return;
    let active = true;
    fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((text) => active && setState({ url, cues: parseVtt(text), failed: false }))
      .catch(() => active && setState({ url, cues: null, failed: true }));
    return () => {
      active = false;
    };
  }, [url]);
  return state.url === url ? { cues: state.cues, failed: state.failed } : { cues: null, failed: false };
}

export function LanguageBadge({ name }: { name: string }) {
  const t = useT();
  return (
    <span className="flex h-7 items-center gap-1.5 rounded-full border border-[#2c3a14] bg-[#161b12] px-2.5 text-xs font-semibold text-accent">
      <GlobeIcon size={14} />
      {name} · {t.clip.detected}
    </span>
  );
}

/**
 * Lista de frases con su tiempo. Resalta la que suena (`current`) y permite saltar a una frase.
 * `offset` suma segundos a los tiempos mostrados (p. ej. para ver tiempos del video original).
 */
export function CueList({
  cues,
  current,
  onSeek,
}: {
  cues: Cue[];
  current?: number;
  onSeek?: (seconds: number) => void;
}) {
  return (
    <ol className="space-y-0.5">
      {cues.map((cue, i) => {
        const active = current !== undefined && current >= cue.start && current < cue.end;
        const content = (
          <>
            <span className={`w-12 shrink-0 pt-px text-xs tabular-nums ${active ? "text-accent" : "text-[#5b6377]"}`}>{clock(cue.start)}</span>
            <span className={`text-sm leading-5 ${active ? "font-semibold text-foreground" : "text-[#a3aabb]"}`}>{cue.text}</span>
          </>
        );
        return (
          <li key={`${cue.start}-${i}`}>
            {onSeek ? (
              <button
                type="button"
                onClick={() => onSeek(cue.start)}
                aria-current={active ? "true" : undefined}
                className={`flex w-full gap-3 rounded-[10px] px-2.5 py-2 text-left ${active ? "bg-[#1b2030]" : "hover:bg-[#161a24]"}`}
              >
                {content}
              </button>
            ) : (
              <div className="flex gap-3 rounded-[10px] px-2.5 py-2">{content}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** Botón "Copiar texto" con confirmación. */
export function CopyTextButton({ cues }: { cues: Cue[] }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const text = useMemo(() => cues.map((c) => c.text).join(" "), [cues]);
  return (
    <button
      type="button"
      onClick={() =>
        navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          })
          .catch(() => undefined)
      }
      className="flex h-11 items-center justify-center gap-1.5 rounded-xl border border-[#2a3040] bg-background text-[13px] font-semibold"
    >
      <CopyIcon size={16} />
      {copied ? t.clip.copied : t.clip.copy}
    </button>
  );
}
