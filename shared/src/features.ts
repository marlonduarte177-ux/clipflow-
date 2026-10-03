/**
 * Interruptores de funciones. Un solo lugar para la API y la web: cambiar el valor, fusionar y
 * desplegar.
 */
export const FEATURES = {
  /**
   * «Descargar solo el video» (bajar un video de otra plataforma tal cual, sin clips).
   * Desactivado el 03/10/2026 para cumplir con la pasarela de pago (Paddle). Con `false`:
   * - la API rechaza las importaciones `downloadOnly` y no entrega el original de un video
   *   importado por enlace;
   * - la web no muestra el botón ni los botones de descarga.
   * Los clips generados se siguen pudiendo descargar.
   */
  downloadOnly: false,
} as const;

export const DOWNLOAD_DISABLED_MESSAGE =
  "Por ahora ClipFlow no ofrece descargar videos de otras plataformas. Puedes crear clips con el enlace.";
