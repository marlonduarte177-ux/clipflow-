import { Logo } from "@/components/ui";
import { SignOutButton } from "@/components/sign-out-button";
import { requireUser } from "@/lib/session";

export const metadata = { title: "Panel · ClipFlow" };

export default async function DashboardPage() {
  const user = await requireUser();

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-line px-4 py-3 sm:px-8">
        <Logo />
        <SignOutButton />
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-8">
        <h1 className="text-2xl font-semibold">Hola 👋</h1>
        <p className="mt-1 text-muted">
          Sesión iniciada como <span className="text-foreground">{user.email}</span>
        </p>
        <section className="mt-8 rounded-2xl border border-dashed border-line p-6 text-sm text-muted">
          Tu cuenta está lista. Proyectos, subida de videos y clips se habilitan en las siguientes fases
          de construcción.
        </section>
      </main>
    </div>
  );
}
