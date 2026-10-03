import Link from "next/link";
import { BackIcon } from "@/components/icons";

export const metadata = { title: "Próximamente · ClipFlow" };

export default async function ComingSoonPage({ searchParams }: { searchParams: Promise<{ que?: string | string[] }> }) {
  const { que } = await searchParams;
  const title = (Array.isArray(que) ? que[0] : que)?.slice(0, 60) || "Próximamente";
  return (
    <div className="mx-auto max-w-xl">
      <Link href="/dashboard/cuenta" className="inline-flex items-center gap-1 text-sm text-muted hover:text-foreground">
        <BackIcon size={18} />
        Cuenta
      </Link>
      <h1 className="mt-4 text-[28px] font-extrabold tracking-tight">{title}</h1>
      <div className="mt-5 rounded-2xl border border-[#1C2029] bg-[#12151B] px-5 py-8 text-center">
        <p className="text-base font-semibold">Próximamente</p>
        <p className="mt-1 text-[15px] text-[#8B909A]">Estamos trabajando en esto. Muy pronto estará disponible.</p>
      </div>
    </div>
  );
}
