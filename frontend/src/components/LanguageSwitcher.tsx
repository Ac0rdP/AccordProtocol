import { useTranslation } from "react-i18next";
import { SUPPORTED_LANGUAGES, setStoredLanguage, type SupportedLanguageCode } from "../i18n";

type Props = {
  className?: string;
};

export function LanguageSwitcher({ className }: Props) {
  const { i18n, t } = useTranslation();

  function handleChange(code: SupportedLanguageCode) {
    void i18n.changeLanguage(code);
    setStoredLanguage(code);
  }

  return (
    <select
      aria-label={t("languageSwitcher.label")}
      value={i18n.language}
      onChange={(e) => handleChange(e.target.value as SupportedLanguageCode)}
      className={`bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1.5 text-xs text-zinc-300 focus:outline-none focus:ring-2 focus:ring-zinc-400 ${className ?? ""}`}
    >
      {SUPPORTED_LANGUAGES.map(({ code, label }) => (
        <option key={code} value={code}>
          {label}
        </option>
      ))}
    </select>
  );
}
