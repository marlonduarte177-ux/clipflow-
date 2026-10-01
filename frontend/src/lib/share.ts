/**
 * Compartir un clip desde el celular: abre el menú del sistema (TikTok, Instagram, WhatsApp…)
 * con el ARCHIVO de video. Si el navegador no puede compartir archivos (p. ej. muchas
 * computadoras), devuelve "unsupported" y la web ofrece descargarlo.
 */
export async function shareVideoFile(url: string, filename: string, title: string): Promise<"shared" | "cancelled" | "unsupported"> {
  if (typeof navigator === "undefined" || !navigator.share || !navigator.canShare) return "unsupported";
  const probe = new File([new Blob()], filename, { type: "video/mp4" });
  if (!navigator.canShare({ files: [probe] })) return "unsupported";
  const response = await fetch(url);
  if (!response.ok) throw new Error("No se pudo preparar el video para compartir.");
  const file = new File([await response.blob()], filename, { type: "video/mp4" });
  try {
    await navigator.share({ files: [file], title });
    return "shared";
  } catch (err) {
    if ((err as Error).name === "AbortError") return "cancelled";
    throw err;
  }
}
