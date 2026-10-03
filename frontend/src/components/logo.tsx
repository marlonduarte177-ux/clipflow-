import Link from "next/link";

/** Símbolo de ClipFlow: tres barras, la del medio en naranja. */
export function LogoMark({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg viewBox="2 15.5 44 17" aria-hidden="true" className={className} style={style}>
      <rect x="2" y="26.5" width="16" height="6" rx="3" fill="#F3F4F6" />
      <rect x="20" y="15.5" width="14" height="6" rx="3" fill="#FF5A1F" />
      <rect x="36" y="26.5" width="10" height="6" rx="3" fill="#F3F4F6" />
    </svg>
  );
}

/**
 * Logo: el símbolo seguido de "clipflow" en Instrument Sans 600.
 * El símbolo mide en `em`, así escala con `size` y su base queda sobre la línea base del texto.
 */
export function Logo({ size = 23, href = "/" }: { size?: number; href?: string | null }) {
  const content = (
    <span
      className="inline-flex items-baseline whitespace-nowrap font-brand font-semibold leading-none text-[#F3F4F6]"
      style={{ fontSize: size, letterSpacing: "-0.02em", gap: "0.3em" }}
    >
      <LogoMark className="inline-block shrink-0" style={{ height: "0.72em", width: "1.864em" }} />
      clipflow
    </span>
  );
  if (href === null) return content;
  return (
    <Link href={href} aria-label="clipflow" className="inline-flex">
      {content}
    </Link>
  );
}
