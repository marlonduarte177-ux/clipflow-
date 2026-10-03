/** Códigos cortos que también puede informar Whisper. */
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
  const key = CODES[raw] ?? raw;
  return names[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}
