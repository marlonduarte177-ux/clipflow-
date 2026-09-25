import { Suspense } from "react";
import { AuthCard } from "@/components/ui";
import { LoginForm } from "./login-form";

export const metadata = { title: "Iniciar sesión · ClipFlow" };

export default function LoginPage() {
  return (
    <AuthCard title="Inicia sesión" subtitle="Entra a tu cuenta de ClipFlow.">
      <Suspense>
        <LoginForm />
      </Suspense>
    </AuthCard>
  );
}
