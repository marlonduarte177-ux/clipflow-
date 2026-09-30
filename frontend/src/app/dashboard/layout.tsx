import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/components/ui";
import { SignOutButton } from "@/components/sign-out-button";
import { requireUser } from "@/lib/session";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-8">
        <Logo />
        <div className="flex items-center gap-2">
          <span className="hidden text-sm text-muted sm:inline">{user.email}</span>
          <SignOutButton />
        </div>
      </header>
      <nav className="flex gap-1 border-b border-line px-4 text-sm sm:px-8">
        <Link href="/dashboard" className="px-3 py-2.5 text-muted hover:text-foreground">
          Proyectos
        </Link>
        <Link href="/dashboard/subir" className="px-3 py-2.5 text-muted hover:text-foreground">
          Subir video
        </Link>
      </nav>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-8">{children}</main>
    </div>
  );
}
