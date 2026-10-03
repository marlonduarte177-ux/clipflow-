"use client";

import { DEFAULT_PRODUCT_CONFIG, type SubtitleStyle } from "@clipflow/shared";
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
  return (
    <fieldset className="space-y-2.5" disabled={disabled}>
      <legend className="flex w-full items-baseline justify-between">
        <span className="text-[15px] font-semibold">Duración de cada clip</span>
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
      <p className="text-xs text-muted">Aproximada: se ajusta unos segundos para no cortar frases a la mitad.</p>
    </fieldset>
  );
}

const STYLES: { id: SubtitleStyle; label: string }[] = [
  { id: "highlight", label: "Resaltado" },
  { id: "classic", label: "Clásico" },
  { id: "none", label: "Sin subtítulos" },
];

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
  return (
    <fieldset className="space-y-2.5" disabled={disabled}>
      <legend className="text-[15px] font-semibold">Subtítulos en el video</legend>
      <div className="grid grid-cols-3 gap-2.5">
        {STYLES.map((s) => (
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
              {s.id === "highlight" ? (
                <span className="text-[13px] font-extrabold tracking-wide text-white [text-shadow:0_1px_2px_#000]">
                  ESTO ES <span className="text-accent">CLAVE</span>
                </span>
              ) : s.id === "classic" ? (
                <span className="rounded bg-black/65 px-1.5 py-0.5 text-xs font-semibold text-white">Esto es clave</span>
              ) : (
                <BlockIcon size={22} className="text-[#5b6377]" />
              )}
            </span>
            {s.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted">También recibes los subtítulos en archivo (.srt) para editarlos.</p>
    </fieldset>
  );
}
