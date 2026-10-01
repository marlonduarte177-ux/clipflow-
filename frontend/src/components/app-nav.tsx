"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { UploadIcon, UserIcon, VideosIcon } from "./icons";

const isVideos = (path: string) => path === "/dashboard" || path.startsWith("/dashboard/videos");
const isAccount = (path: string) => path.startsWith("/dashboard/cuenta");
const isUpload = (path: string) => path.startsWith("/dashboard/subir");

/**
 * Barra inferior en el celular: "Mis videos", "Subir video" (botón verde con la forma del logo)
 * y "Cuenta". La sección actual se marca en verde.
 */
export function BottomNav() {
  const path = usePathname();
  const tab = (active: boolean) =>
    `flex h-16 w-20 flex-col items-center gap-1 text-[11px] ${active ? "font-semibold text-accent" : "font-medium text-muted"}`;
  const marker = (active: boolean) => <span className={`h-[3px] w-7 rounded-b ${active ? "bg-accent" : ""}`} />;
  return (
    <nav
      aria-label="Navegación principal"
      className="fixed inset-x-0 bottom-0 z-30 flex items-start justify-between border-t border-[#1e2330] bg-[#0e1118] px-8 pb-[max(16px,env(safe-area-inset-bottom))] sm:hidden"
    >
      <Link href="/dashboard" aria-current={isVideos(path) ? "page" : undefined} className={tab(isVideos(path))}>
        {marker(isVideos(path))}
        <VideosIcon size={24} className="mt-1.5" />
        Mis videos
      </Link>
      <Link
        href="/dashboard/subir"
        aria-current={isUpload(path) ? "page" : undefined}
        className="-mt-5 flex w-20 flex-col items-center gap-1.5 text-[11px] font-semibold text-foreground"
      >
        <span className="grid h-[58px] w-[58px] place-items-center rounded-[18px] bg-accent text-black shadow-[0_0_0_5px_#0e1118]">
          <UploadIcon size={26} strokeWidth={2.4} />
        </span>
        Subir video
      </Link>
      <Link href="/dashboard/cuenta" aria-current={isAccount(path) ? "page" : undefined} className={tab(isAccount(path))}>
        {marker(isAccount(path))}
        <UserIcon size={24} className="mt-1.5" />
        Cuenta
      </Link>
    </nav>
  );
}

/** Enlaces del encabezado en pantallas grandes. */
export function TopNav() {
  const path = usePathname();
  const link = (active: boolean) =>
    `rounded-lg px-3 py-2 text-sm ${active ? "bg-surface font-medium text-foreground" : "text-muted hover:text-foreground"}`;
  return (
    <nav aria-label="Navegación principal" className="hidden items-center gap-1 sm:flex">
      <Link href="/dashboard" className={link(isVideos(path))}>
        Mis videos
      </Link>
      <Link href="/dashboard/cuenta" className={link(isAccount(path))}>
        Cuenta
      </Link>
      <Link href="/dashboard/subir" className="ml-2 flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-black">
        <UploadIcon size={18} strokeWidth={2.4} />
        Subir video
      </Link>
    </nav>
  );
}
