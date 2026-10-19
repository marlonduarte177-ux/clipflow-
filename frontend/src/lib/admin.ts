"use client";

import { useEffect, useState } from "react";
import { apiConfigured, apiFetch } from "./api";

/** ¿Es un correo de administrador? (herramientas internas como «Guardar»). La API lo vuelve a revisar. */
export function useIsAdmin(): boolean {
  const [admin, setAdmin] = useState(false);
  useEffect(() => {
    if (!apiConfigured) return;
    let active = true;
    apiFetch<{ admin: boolean }>("/admin/me")
      .then((r) => active && setAdmin(r.admin))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  return admin;
}
