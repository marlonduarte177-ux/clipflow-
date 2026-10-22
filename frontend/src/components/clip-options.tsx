"use client";

import { DEFAULT_PRODUCT_CONFIG, type SubtitleStyle } from "@clipflow/shared";
import { useT } from "@/i18n/provider";
import { BlockIcon } from "./icons";

export const CLIP_DURATIONS = DEFAULT_PRODUCT_CONFIG.clipDurationsSeconds;
export const DEFAULT_DURATION = DEFAULT_PRODUCT_CONFIG.defaultClipDurationSeconds;

/** Duración de cada clip: botones grandes, fáciles de tocar en el celular. */
export function DurationPicker({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (seconds: number) => void;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <fieldset className="space-y-2.5" disabled={disabled}>
      <legend className="flex w-full items-baseline justify-between">
        <span className="text-[15px] font-semibold">{t.options.duration}</span>
      </legend>
      <div className="grid grid-cols-5 gap-2">
        {CLIP_DURATIONS.map((d) => (
          <button
            key={d}
            type="button"
            aria-pressed={value === d}
            onClick={() => onChange(d)}
            className={`h-11 rounded-xl border text-sm font-semibold transition disabled:opacity-50 ${
              value === d ? "border-accent bg-accent text-on-accent" : "border-line bg-surface text-foreground hover:border-[#3a4256]"
            }`}
          >
            {d} s
          </button>
        ))}
      </div>
      <p className="text-xs text-muted">{t.options.durationHint}</p>
    </fieldset>
  );
}

const STYLES: SubtitleStyle[] = ["highlight", "karaoke", "pop", "gamer", "box", "classic", "minimal", "none"];

/** Vista previa de cada estilo (parecida a cómo se ve en el video). */
function StylePreview({ id }: { id: SubtitleStyle }) {
  const t = useT();
  const [a, b] = t.options.previewHighlight;
  switch (id) {
    case "highlight":
      return (
        <span className="text-[11px] font-extrabold tracking-wide text-white [text-shadow:0_1px_2px_#000]">
          {a} <span className="text-[#c6f432]">{b}</span>
        </span>
      );
    case "karaoke":
      return (
        <span className="text-[11px] font-extrabold tracking-wide text-white [text-shadow:0_1px_2px_#000]">
          {a} <span className="inline-block scale-110 text-[#ffd60a]">{b}</span>
        </span>
      );
    case "pop":
      return <span className="text-[15px] font-black text-white [text-shadow:1px_1.5px_0_#ff5a1f]">{b}</span>;
    case "gamer":
      return (
        <span className="-skew-x-12 text-[11px] font-extrabold tracking-wider text-white [text-shadow:0_1px_2px_#000]">
          {a} <span className="text-[#4ade80]">{b}</span>
        </span>
      );
    case "box":
      return (
        <span className="rounded bg-[#ffd60a] px-1 py-0.5 text-[10px] font-extrabold text-[#101010]">
          {a} {b}
        </span>
      );
    case "classic":
      return <span className="rounded bg-black/65 px-1 py-0.5 text-[10px] font-semibold text-white">{t.options.previewClassic}</span>;
    case "minimal":
      return <span className="text-[10px] font-medium text-white [text-shadow:0_1px_1px_#000]">{t.options.previewClassic}</span>;
    default:
      return <BlockIcon size={20} className="text-[#5b6377]" />;
  }
}

/** Estilo de los subtítulos dibujados en el video, con una vista previa de cada uno. */
export function SubtitlePicker({
  value,
  onChange,
  disabled,
}: {
  value: SubtitleStyle;
  onChange: (style: SubtitleStyle) => void;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <fieldset className="space-y-2.5" disabled={disabled}>
      <legend className="text-[15px] font-semibold">{t.options.subtitles}</legend>
      <div className="grid grid-cols-4 gap-2">
        {STYLES.map((id) => (
          <button
            key={id}
            type="button"
            aria-pressed={value === id}
            onClick={() => onChange(id)}
            className={`flex min-h-[44px] flex-col gap-1.5 rounded-2xl border-2 bg-surface p-1 pb-2 text-[12px] font-semibold transition disabled:opacity-50 ${
              value === id ? "border-accent" : "border-line hover:border-[#3a4256]"
            }`}
          >
            <span className="flex h-[70px] items-end justify-center overflow-hidden rounded-xl bg-[#1b1f2a] px-1 pb-2.5 text-center leading-tight">
              <StylePreview id={id} />
            </span>
            {t.options[id]}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted">{t.options.srtHint}</p>
    </fieldset>
  );
}
