import { SignOutButton } from "@/components/sign-out-button";
import { requireUser } from "@/lib/session";

export const metadata = { title: "Cuenta · ClipFlow" };

export default async function AccountPage() {
  const user = await requireUser();
  return (
    <div className="mx-auto max-w-xl space-y-6">
      <h1 className="text-[28px] font-bold tracking-tight">Cuenta</h1>
      <dl className="rounded-2xl border border-line bg-surface">
        <div className="flex items-center justify-between gap-4 px-4 py-4">
          <dt className="text-sm text-muted">Correo</dt>
          <dd className="min-w-0 truncate text-sm font-medium">{user.email}</dd>
        </div>
      </dl>
      <SignOutButton />
    </div>
  );
}
