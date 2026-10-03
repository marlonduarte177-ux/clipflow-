import Link from "next/link";
import { BackIcon } from "@/components/icons";
import { getT, pageTitle } from "@/i18n/server";

export async function generateMetadata() {
  return { title: await pageTitle("soon") };
}

export default async function ComingSoonPage({ searchParams }: { searchParams: Promise<{ que?: string | string[] }> }) {
  const [{ que }, t] = await Promise.all([searchParams, getT()]);
  const topic = Array.isArray(que) ? que[0] : que;
  const title = (topic && t.soon.topics[topic]) || t.soon.title;
  return (
    <div className="mx-auto max-w-xl">
      <Link href="/dashboard/cuenta" className="inline-flex items-center gap-1 text-sm text-muted hover:text-foreground">
        <BackIcon size={18} />
        {t.meta.account}
      </Link>
      <h1 className="mt-4 text-[28px] font-extrabold tracking-tight">{title}</h1>
      <div className="mt-5 rounded-2xl border border-[#1C2029] bg-[#12151B] px-5 py-8 text-center">
        <p className="text-base font-semibold">{t.soon.title}</p>
        <p className="mt-1 text-[15px] text-[#8B909A]">{t.soon.text}</p>
      </div>
    </div>
  );
}
