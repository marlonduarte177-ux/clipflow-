import { Suspense } from "react";
import { AuthCard } from "@/components/ui";
import { VerifyForm } from "./verify-form";

export const metadata = { title: "Verificar email · ClipFlow" };

export default function VerifyPage() {
  return (
    <AuthCard title="Verifica tu email" subtitle="Escribe el código que te enviamos por email.">
      <Suspense>
        <VerifyForm />
      </Suspense>
    </AuthCard>
  );
}
