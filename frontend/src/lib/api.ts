import { fetchAuthSession } from "aws-amplify/auth";
import { translateMessage, type ApiErrorResponse } from "@clipflow/shared";
import { clientLocale } from "@/i18n/locale";

/** URL pública de la API (no es secreta). */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");
export const apiConfigured = API_URL !== "";

/** Error de la API con el mensaje ya traducido al idioma de la app (el servidor responde en español). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(translateMessage(message, clientLocale()));
    this.name = "ApiError";
  }
}

/** Llama a la API con el token de la sesión actual (Cognito). Solo en el navegador. */
export async function apiFetch<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  if (!apiConfigured) throw new ApiError("La API todavía no está configurada (NEXT_PUBLIC_API_URL).", 0, "not_configured");
  const session = await fetchAuthSession();
  const token = session.tokens?.accessToken?.toString();
  if (!token) throw new ApiError("Tu sesión expiró. Vuelve a iniciar sesión.", 401, "unauthorized");

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError("No se pudo conectar con el servidor. Revisa tu internet.", 0, "network_error");
  }

  if (response.status === 204) return undefined as T;
  const data = (await response.json().catch(() => null)) as (T & Partial<ApiErrorResponse>) | null;
  if (!response.ok) {
    throw new ApiError(
      data?.error?.message ?? "Ocurrió un error inesperado. Intenta de nuevo.",
      response.status,
      data?.error?.code ?? "unknown",
    );
  }
  return data as T;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function formatDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}
