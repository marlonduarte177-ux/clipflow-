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
      <div className="grid grid-cols-4 gap-2">
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
            {t.options.length(d)}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted">{t.options.durationHint}</p>
    </fieldset>
  );
}

const STYLES: SubtitleStyle[] = ["highlight", "classic", "word", "yellow", "neon", "minimal", "none"];

/** Vista previa de cada estilo (imita cómo se ve en el video). */
function StylePreview({ id }: { id: SubtitleStyle }) {
  const t = useT();
  const bold = "text-[13px] font-extrabold tracking-wide";
  switch (id) {
    case "highlight":
      return (
        <span className={`${bold} text-white [text-shadow:0_1px_2px_#000]`}>
          {t.options.previewHighlight[0]} <span className="text-[#c6f432]">{t.options.previewHighlight[1]}</span>
        </span>
      );
    case "classic":
      return <span className="rounded bg-black/65 px-1.5 py-0.5 text-xs font-semibold text-white">{t.options.previewClassic}</span>;
    case "word":
      return <span className="text-lg font-black text-white [-webkit-text-stroke:1px_#000] [text-shadow:0_2px_3px_#000]">{t.options.previewWord}</span>;
    case "yellow":
      return (
        <span className={`${bold} text-[#ffff00] [text-shadow:0_1px_2px_#000]`}>
          {t.options.previewHighlight[0]} <span className="text-[15px]">{t.options.previewHighlight[1]}</span>
        </span>
      );
    case "neon":
      return (
        <span className={`${bold} text-white [text-shadow:0_0_6px_#ff5a1f,0_0_2px_#ff5a1f]`}>
          {t.options.previewHighlight[0]}{" "}
          <span className="text-[#ff5a1f] [text-shadow:0_0_6px_#fff]">{t.options.previewHighlight[1]}</span>
        </span>
      );
    case "minimal":
      return <span className="text-[11px] font-semibold text-white [text-shadow:0_2px_4px_rgba(0,0,0,.6)]">{t.options.previewMinimal}</span>;
    default:
      return <BlockIcon size={22} className="text-[#5b6377]" />;
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
      <div className="grid grid-cols-3 gap-2.5">
        {STYLES.map((id) => ({ id, label: t.options[id] })).map((s) => (
          <button
            key={s.id}
            type="button"
            aria-pressed={value === s.id}
            onClick={() => onChange(s.id)}
            className={`flex flex-col gap-2 rounded-2xl border-2 bg-surface p-1.5 pb-2.5 text-[13px] font-semibold transition disabled:opacity-50 ${
              value === s.id ? "border-accent" : "border-line hover:border-[#3a4256]"
            }`}
          >
            <span className="flex h-[88px] items-end justify-center rounded-xl bg-[#1b1f2a] pb-3">
              <StylePreview id={s.id} />
            </span>
            {s.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted">{t.options.srtHint}</p>
    </fieldset>
  );
}
