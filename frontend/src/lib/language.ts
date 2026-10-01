/** Whisper informa el idioma en inglés ("spanish"); se muestra en español. */
const NAMES: Record<string, string> = {
  spanish: "Español",
  english: "Inglés",
  portuguese: "Portugués",
  french: "Francés",
  italian: "Italiano",
  german: "Alemán",
  catalan: "Catalán",
  dutch: "Neerlandés",
  russian: "Ruso",
  japanese: "Japonés",
  korean: "Coreano",
  chinese: "Chino",
  arabic: "Árabe",
  hindi: "Hindi",
  turkish: "Turco",
  polish: "Polaco",
  ukrainian: "Ucraniano",
  galician: "Gallego",
  basque: "Euskera",
  es: "Español",
  en: "Inglés",
  pt: "Portugués",
  fr: "Francés",
  it: "Italiano",
  de: "Alemán",
};

export function languageName(language: string | null | undefined): string | null {
  if (!language) return null;
  const key = language.trim().toLowerCase();
  if (!key) return null;
  return NAMES[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}
