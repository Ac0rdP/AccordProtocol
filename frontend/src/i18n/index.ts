import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en/translation.json";
import es from "./locales/es/translation.json";
import ar from "./locales/ar/translation.json";

export const SUPPORTED_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
  { code: "ar", label: "العربية" },
] as const;

export type SupportedLanguageCode = (typeof SUPPORTED_LANGUAGES)[number]["code"];

/** BCP 47 primary language subtags that read right-to-left. */
const RTL_LANGUAGES = new Set(["ar", "he", "fa", "ur"]);

export type TextDirection = "ltr" | "rtl";

export function getTextDirection(code: string): TextDirection {
  const primarySubtag = code.split("-")[0].toLowerCase();
  return RTL_LANGUAGES.has(primarySubtag) ? "rtl" : "ltr";
}

/** Keeps <html dir>/<html lang> in sync with the active language, so logical
 * CSS/Tailwind properties (ms-, me-, text-start, …) flip automatically. */
function applyDocumentDirection(code: string): void {
  if (typeof document === "undefined") return;
  document.documentElement.dir = getTextDirection(code);
  document.documentElement.lang = code;
}

const LANGUAGE_STORAGE_KEY = "accord_language";

export function getStoredLanguage(): SupportedLanguageCode {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (SUPPORTED_LANGUAGES.some((language) => language.code === stored)) {
      return stored as SupportedLanguageCode;
    }
  } catch {
    // localStorage might be unavailable or throw in restricted environments
  }
  return "en";
}

export function setStoredLanguage(code: SupportedLanguageCode): void {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, code);
  } catch {
    // ignore storage errors
  }
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    es: { translation: es },
    ar: { translation: ar },
  },
  lng: getStoredLanguage(),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

applyDocumentDirection(i18n.language ?? getStoredLanguage());
i18n.on("languageChanged", applyDocumentDirection);

export default i18n;
