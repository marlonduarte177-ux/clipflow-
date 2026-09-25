import Link from "next/link";
import { Logo } from "@/components/ui";

const STEPS = [
  { title: "Sube tu video", text: "Directo desde tu navegador, incluso archivos largos." },
  { title: "ClipFlow lo analiza", text: "Transcribe el audio y detecta los momentos con más interés." },
  { title: "Revisa tus clips", text: "Verticales 9:16, con subtítulos. Aprueba, edita y descarga." },
];

export default function Home() {
  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between px-4 py-4 sm:px-8">
        <Logo />
        <nav className="flex items-center gap-2 text-sm">
          <Link href="/login" className="rounded-lg px-3 py-1.5 text-muted hover:text-foreground">
            Entrar
          </Link>
          <Link href="/registro" className="rounded-lg bg-accent px-3 py-1.5 font-medium text-black">
            Crear cuenta
          </Link>
        </nav>
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 sm:px-8">
        <section className="py-16 sm:py-24">
          <h1 className="max-w-2xl text-4xl font-semibold leading-tight tracking-tight sm:text-6xl">
            De un video largo a clips listos para redes.
          </h1>
          <p className="mt-5 max-w-xl text-lg text-muted">
            ClipFlow encuentra los mejores momentos de tus videos y los convierte en clips verticales con
            subtítulos.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/registro" className="rounded-lg bg-accent px-5 py-3 font-medium text-black">
              Empezar
            </Link>
            <Link href="/login" className="rounded-lg border border-line px-5 py-3 text-muted hover:text-foreground">
              Ya tengo cuenta
            </Link>
          </div>
        </section>

        <section aria-labelledby="como-funciona" className="pb-20">
          <h2 id="como-funciona" className="text-sm font-medium uppercase tracking-widest text-muted">
            Cómo funciona
          </h2>
          <ol className="mt-6 grid gap-4 sm:grid-cols-3">
            {STEPS.map((step, i) => (
              <li key={step.title} className="rounded-2xl border border-line bg-surface p-5">
                <span className="text-sm text-accent">{i + 1}</span>
                <h3 className="mt-2 font-medium">{step.title}</h3>
                <p className="mt-1 text-sm text-muted">{step.text}</p>
              </li>
            ))}
          </ol>
        </section>
      </main>

      <footer className="border-t border-line px-4 py-6 text-sm text-muted sm:px-8">© ClipFlow</footer>
    </div>
  );
}
