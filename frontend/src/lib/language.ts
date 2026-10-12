/** Códigos cortos (los informa Deepgram; Whisper a veces). */
const CODES: Record<string, string> = {
  es: "spanish",
  en: "english",
  pt: "portuguese",
  fr: "french",
  it: "italian",
  de: "german",
};

/**
 * Whisper informa el idioma en inglés ("spanish"); se muestra en el idioma de la app con `names`
 * (los textos de `t.languages`).
 */
export function languageName(language: string | null | undefined, names: Record<string, string>): string | null {
  if (!language) return null;
  const raw = language.trim().toLowerCase();
  if (!raw) return null;
  // Deepgram informa códigos BCP-47 ("es", "es-419", "en-US"): cuenta el idioma, no la región.
  const key = CODES[raw] ?? CODES[raw.split("-")[0]!] ?? raw;
  return names[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}
