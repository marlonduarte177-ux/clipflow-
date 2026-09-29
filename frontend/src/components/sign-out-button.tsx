"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { signOut } from "aws-amplify/auth";

export function SignOutButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function onClick() {
    setLoading(true);
    try {
      await signOut();
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }

  return (
    <button
      onClick={onClick}
      disabled={loading}
      className="rounded-lg border border-line px-3 py-1.5 text-sm text-muted transition hover:text-foreground disabled:opacity-60"
    >
      {loading ? "Saliendo…" : "Cerrar sesión"}
    </button>
  );
}
