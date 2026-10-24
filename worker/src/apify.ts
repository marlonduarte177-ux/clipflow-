import { DownloadError } from "./download.js";

/**
 * YouTube con Apify (solo para los administradores). YouTube bloquea la descarga desde nuestros
 * servidores, así que la hace el actor `api-ninja/youtube-video-downloader` de Apify (~0,07–0,13 USD
 * por video) y nosotros solo bajamos el archivo que entrega.
 * - Formato "1080": la mejor calidad que se nota en un clip vertical de 1080x1920 y la opción rápida
 *   del actor (1440p y 4K son lentas y no se verían mejor).
 * - Sin almacenamiento persistente: el enlace temporal dura ~15 min y se baja apenas termina.
 * La clave nunca se registra ni aparece en errores.
 */
export const APIFY_ACTOR = "api-ninja~youtube-video-downloader";
const APIFY_API = "https://api.apify.com/v2";

/** Las claves de Apify empiezan con `apify_api_`; el valor de relleno de AWS no. */
export function isApifyToken(value: string | undefined): value is string {
  return /^apify_api_[A-Za-z0-9]{20,}$/.test(value?.trim() ?? "");
}

export interface ApifyOptions {
  token: string;
  /** Tiempo máximo de la ejecución en Apify (s). */
  timeoutSeconds?: number;
  /** Cada cuánto se pregunta si terminó (s, espera larga del lado de Apify). */
  waitSeconds?: number;
  signal?: AbortSignal;
  /** Solo para tests. */
  apiBase?: string;
  fetch?: typeof fetch;
}

export interface ApifyResult {
  downloadUrl: string;
  title: string | null;
}

interface RunData {
  id: string;
  status: string;
  defaultDatasetId: string;
}

/** Pide el video a Apify y espera el enlace de descarga. */
export async function fetchYoutubeViaApify(url: string, options: ApifyOptions): Promise<ApifyResult> {
  const doFetch = options.fetch ?? fetch;
  const base = options.apiBase ?? APIFY_API;
  const headers = { authorization: `Bearer ${options.token.trim()}`, "content-type": "application/json" };
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, { ...init, headers, signal: options.signal });
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      throw new DownloadError("No se pudo conectar con el servicio de YouTube. Lo intentaremos de nuevo.", true, false, "apify: sin conexión");
    }
    if (res.status === 401 || res.status === 403) {
      throw new DownloadError("La clave de Apify no es válida. Revísala en AWS.", false, false, `apify: ${res.status}`);
    }
    if (res.status === 402) {
      throw new DownloadError("La cuenta de Apify no tiene saldo para descargar de YouTube.", false, false, "apify: 402");
    }
    if (!res.ok) throw new DownloadError("El servicio de YouTube no respondió. Lo intentaremos de nuevo.", true, false, `apify: ${res.status}`);
    return res;
  };

  const timeout = Math.floor(options.timeoutSeconds ?? 3600);
  const started = await call(`/acts/${APIFY_ACTOR}/runs?timeout=${timeout}&maxTotalChargeUsd=0.5`, {
    method: "POST",
    body: JSON.stringify({ urls: [url], format: "1080", ttl: "none" }),
  });
  let run = ((await started.json()) as { data: RunData }).data;
  const abort = () => void doFetch(`${base}/actor-runs/${run.id}/abort`, { method: "POST", headers }).catch(() => undefined);
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const wait = Math.floor(options.waitSeconds ?? 60);
    while (run.status === "READY" || run.status === "RUNNING") {
      run = ((await (await call(`/actor-runs/${run.id}?waitForFinish=${wait}`)).json()) as { data: RunData }).data;
    }
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
  if (run.status !== "SUCCEEDED") {
    throw new DownloadError("No pudimos descargar ese video de YouTube.", run.status === "TIMED-OUT", false, `apify: ${run.status}`);
  }
  const items = (await (await call(`/datasets/${run.defaultDatasetId}/items?clean=true`)).json()) as {
    downloadUrl?: string;
    storageUrl?: string;
    title?: string;
    status?: string;
  }[];
  const item = items.find((i) => typeof i.downloadUrl === "string" || typeof i.storageUrl === "string");
  // Sin resultados: el actor salta los videos privados, borrados o de cuentas cerradas.
  if (!item) throw new DownloadError("Ese video de YouTube es privado o ya no existe.", false, false, "apify: sin resultados");
  return { downloadUrl: (item.downloadUrl ?? item.storageUrl)!, title: typeof item.title === "string" ? item.title : null };
}
