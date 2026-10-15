"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { minutesForSeconds, RANGE_MIN_SECONDS } from "@clipflow/shared";
import { useT } from "@/i18n/provider";
import { BackIcon, BoltIcon } from "./icons";

export interface VideoRange {
  startSeconds: number;
  endSeconds: number;
}

/** "92:25": minutos (sin pasar a horas, como en la captura) y segundos. */
export function formatRangeTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Rayitas de la regla. */
const TICKS = 30;
/** Ancho de cada manija (el borde blanco grueso a cada lado de lo elegido). */
const HANDLE_PX = 16;

type Drag = { mode: "start" | "end" | "move"; grab: number };

/**
 * Pantalla «Duración del video»: elegir con el dedo qué tramo procesar. Fondo con la miniatura
 * desenfocada, el tramo en grande, los minutos que gasta y una regla con un selector que se arrastra
 * y se estira (mínimo 2 minutos). Vibra un poco al pasar cada minuto (donde el teléfono lo permite).
 */
export function RangePicker({
  durationSeconds,
  value,
  thumbnailUrl,
  /** Minutos que le quedan al usuario (null: sin límite, p. ej. cuenta exenta o pagos apagados). */
  availableMinutes,
  onCancel,
  onConfirm,
}: {
  durationSeconds: number;
  value: VideoRange | null;
  thumbnailUrl: string | null;
  availableMinutes: number | null;
  onCancel: () => void;
  onConfirm: (range: VideoRange | null) => void;
}) {
  const t = useT();
  const total = Math.max(RANGE_MIN_SECONDS, Math.floor(durationSeconds));
  const [start, setStart] = useState(value?.startSeconds ?? 0);
  const [end, setEnd] = useState(value?.endSeconds ?? total);
  const [dragging, setDragging] = useState<Drag | null>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const lastMinute = useRef<number | null>(null);

  // Mientras está abierta, la página de atrás no se mueve.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  const minutes = minutesForSeconds(end - start);
  const over = availableMinutes !== null && minutes > availableMinutes;

  const buzz = (seconds: number) => {
    const minute = Math.floor(seconds / 60);
    if (lastMinute.current !== null && minute !== lastMinute.current) navigator.vibrate?.(4);
    lastMinute.current = minute;
  };

  const secondsAt = (clientX: number) => {
    const rail = railRef.current!.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (clientX - rail.left) / rail.width));
    return Math.round(fraction * total);
  };

  const apply = (mode: Drag["mode"], at: number, grab = 0) => {
    if (mode === "start") {
      const next = Math.min(Math.max(0, at), end - RANGE_MIN_SECONDS);
      setStart(next);
      buzz(next);
    } else if (mode === "end") {
      const next = Math.max(Math.min(total, at), start + RANGE_MIN_SECONDS);
      setEnd(next);
      buzz(next);
    } else {
      const length = end - start;
      const next = Math.min(Math.max(0, at - grab), total - length);
      setStart(next);
      setEnd(next + length);
      buzz(next);
    }
  };

  // La parte que se toca dice qué hace (data-mode): mover, o estirar desde el inicio o el final.
  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    const mode = e.currentTarget.dataset.mode as Drag["mode"];
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const at = secondsAt(e.clientX);
    lastMinute.current = null;
    setDragging({ mode, grab: mode === "move" ? at - start : 0 });
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    if (!dragging) return;
    apply(dragging.mode, secondsAt(e.clientX), dragging.grab);
  };
  const onPointerUp = () => setDragging(null);

  // Teclado (accesibilidad): flechas mueven 10 s; con Mayúsculas, 1 min.
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    const mode = e.currentTarget.dataset.mode as "start" | "end";
    const step = e.shiftKey ? 60 : 10;
    const delta = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -step : e.key === "ArrowRight" || e.key === "ArrowUp" ? step : 0;
    if (!delta) return;
    e.preventDefault();
    apply(mode, (mode === "start" ? start : end) + delta);
  };

  const left = (start / total) * 100;
  const width = ((end - start) / total) * 100;
  const full = start === 0 && end >= total;

  return (
    <div role="dialog" aria-modal="true" aria-label={t.range.title} className="fixed inset-0 z-[60] overflow-hidden bg-[#0d0f13] text-white animate-[range-in_240ms_ease-out]">
      {/* Fondo: la miniatura del video, muy desenfocada y oscurecida. */}
      {thumbnailUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- imagen de la plataforma, solo de fondo
        <img src={thumbnailUrl} alt="" aria-hidden="true" className="absolute inset-0 h-full w-full scale-150 object-cover opacity-95 blur-[60px] saturate-[1.4]" />
      ) : (
        <div aria-hidden="true" className="absolute inset-0 bg-[radial-gradient(120%_80%_at_20%_10%,#4a4a3a_0%,transparent_60%),radial-gradient(100%_70%_at_80%_80%,#4a3a30_0%,transparent_60%)]" />
      )}
      <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-b from-black/30 via-black/25 to-black/60" />

      <div className="relative mx-auto flex h-full max-w-xl flex-col px-5 pb-[max(env(safe-area-inset-bottom),24px)] pt-[max(env(safe-area-inset-top),16px)]">
        <header className="relative flex h-14 items-center justify-center">
          <button
            type="button"
            onClick={onCancel}
            aria-label={t.common.back}
            className="absolute left-0 grid h-12 w-12 place-items-center rounded-full border border-white/10 bg-white/10 backdrop-blur-md transition active:scale-95"
          >
            <BackIcon size={22} strokeWidth={2.4} />
          </button>
          <h2 className="text-[19px] font-semibold tracking-tight">{t.range.title}</h2>
        </header>

        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <p className="text-[42px] font-bold tabular-nums tracking-tight" aria-live="polite">
            {formatRangeTime(start)} - {formatRangeTime(end)}
          </p>
          <p className={`flex items-center gap-1.5 text-[17px] font-semibold transition-colors ${over ? "text-[#ff5a5a]" : "text-white"}`}>
            {t.range.usage}
            <BoltIcon size={20} strokeWidth={2.2} className={over ? "text-[#ff5a5a]" : "fill-[#f5b82e] text-[#f5b82e]"} />
            <span className="tabular-nums">{minutes}</span>
          </p>
          {over ? (
            <div className="flex flex-col items-center gap-2.5">
              <p className="text-sm text-[#ff9a9a]">{t.range.notEnough(availableMinutes ?? 0)}</p>
              <Link
                href="/dashboard/planes"
                className="rounded-full bg-accent px-5 py-2.5 text-sm font-bold text-on-accent transition active:scale-95"
              >
                {t.range.upgrade}
              </Link>
            </div>
          ) : (
            <p className="max-w-[340px] text-[15px] leading-snug text-white/55">{t.range.hint}</p>
          )}

          {/* Regla con el selector. */}
          <div className="mt-10 w-full touch-none select-none" onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
            <div className="relative h-[60px] rounded-[18px] bg-white/[0.08] px-[16px] backdrop-blur-sm">
              <div ref={railRef} className="relative h-full">
                {/* Rayitas */}
                <div aria-hidden="true" className="absolute inset-y-0 left-0 right-0 flex items-center justify-between">
                  {Array.from({ length: TICKS }, (_, i) => (
                    <span key={i} className="h-[18px] w-[1.5px] rounded-full bg-white/45" />
                  ))}
                </div>
                {/* Selector: borde blanco con dos manijas; lo elegido, más claro. */}
                <div
                  className={`absolute inset-y-0 ${dragging ? "" : "transition-[left,width] duration-200 ease-out"}`}
                  style={{ left: `calc(${left}% - ${HANDLE_PX}px)`, width: `calc(${width}% + ${HANDLE_PX * 2}px)` }}
                >
                  <div
                    data-mode="move"
                    onPointerDown={onPointerDown}
                    className={`absolute inset-0 cursor-grab rounded-[16px] border-y-[4px] border-white bg-white/25 shadow-[0_4px_24px_rgba(0,0,0,0.35)] active:cursor-grabbing ${dragging ? "scale-y-[1.04]" : ""} transition-transform`}
                    style={{ borderLeftWidth: HANDLE_PX, borderRightWidth: HANDLE_PX }}
                  />
                  <span
                    role="slider"
                    tabIndex={0}
                    aria-label={t.range.startAria}
                    aria-valuemin={0}
                    aria-valuemax={end - RANGE_MIN_SECONDS}
                    aria-valuenow={start}
                    aria-valuetext={formatRangeTime(start)}
                    data-mode="start"
                    onKeyDown={onKey}
                    onPointerDown={onPointerDown}
                    className="absolute inset-y-0 left-[-10px] flex w-[36px] cursor-ew-resize items-center justify-center outline-none focus-visible:[&>i]:bg-accent"
                  >
                    <i className="h-[22px] w-[4px] rounded-full bg-[#111]" />
                  </span>
                  <span
                    role="slider"
                    tabIndex={0}
                    aria-label={t.range.endAria}
                    aria-valuemin={start + RANGE_MIN_SECONDS}
                    aria-valuemax={total}
                    aria-valuenow={end}
                    aria-valuetext={formatRangeTime(end)}
                    data-mode="end"
                    onKeyDown={onKey}
                    onPointerDown={onPointerDown}
                    className="absolute inset-y-0 right-[-10px] flex w-[36px] cursor-ew-resize items-center justify-center outline-none focus-visible:[&>i]:bg-accent"
                  >
                    <i className="h-[22px] w-[4px] rounded-full bg-[#111]" />
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <button
          type="button"
          disabled={over}
          onClick={() => onConfirm(full ? null : { startSeconds: start, endSeconds: end })}
          className="h-[60px] w-full rounded-full bg-white text-[18px] font-semibold text-black shadow-[0_8px_30px_rgba(0,0,0,0.35)] transition active:scale-[0.98] disabled:opacity-40"
        >
          {t.range.confirm}
        </button>
      </div>
    </div>
  );
}
