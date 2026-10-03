import { Suspense } from "react";
import { AuthCard } from "@/components/ui";
import { getT, pageTitle } from "@/i18n/server";
import { VerifyForm } from "./verify-form";

export async function generateMetadata() {
  return { title: await pageTitle("verify") };
}

export default async function VerifyPage() {
  const t = await getT();
  return (
    <AuthCard title={t.auth.verifyTitle} subtitle={t.auth.verifySubtitle}>
      <Suspense>
        <VerifyForm />
      </Suspense>
    </AuthCard>
  );
}
