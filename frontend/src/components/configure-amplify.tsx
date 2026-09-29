"use client";

import { Amplify } from "aws-amplify";
import { amplifyConfig, authConfigured } from "@/lib/amplify-config";

// ssr: true guarda la sesión en cookies para que el servidor pueda proteger páginas.
if (authConfigured) {
  Amplify.configure(amplifyConfig, { ssr: true });
}

export function ConfigureAmplify() {
  return null;
}
