import { Suspense } from "react";
import { AuthCard } from "@/components/ui";
import { getT, pageTitle } from "@/i18n/server";
import { LoginForm } from "./login-form";

export async function generateMetadata() {
  return { title: await pageTitle("login") };
}

export default async function LoginPage() {
  const t = await getT();
  return (
    <AuthCard title={t.auth.loginTitle} subtitle={t.auth.loginSubtitle}>
      <Suspense>
        <LoginForm />
      </Suspense>
    </AuthCard>
  );
}
