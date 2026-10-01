import type { ReactNode } from "react";
import { BottomNav, TopNav } from "@/components/app-nav";
import { Logo } from "@/components/ui";
import { requireUser } from "@/lib/session";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  await requireUser();
  return (
    <div className="flex flex-1 flex-col">
      <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-line/60 bg-background/90 px-5 py-3 backdrop-blur sm:px-8">
        <Logo />
        <TopNav />
      </header>
      {/* En el celular, espacio abajo para la barra de navegación. */}
      <main className="mx-auto w-full max-w-5xl flex-1 px-5 pb-32 pt-5 sm:px-8 sm:pb-12">{children}</main>
      <BottomNav />
    </div>
  );
}
