import i18n from "../i18n";

/** The BCP 47 tag of the UI's active language, e.g. "en", "es", "ar". */
export function getActiveLocale(): string {
  return i18n.language || "en";
}

/** Locale-aware number formatting; returns "—" for non-finite input. */
export function formatNumber(
  value: number,
  options?: Intl.NumberFormatOptions,
  locale: string = getActiveLocale(),
): string {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(locale, options).format(value);
}

/** Locale-aware date formatting; returns "—" for an invalid date. */
export function formatDate(
  value: Date | number | string,
  options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" },
  locale: string = getActiveLocale(),
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat(locale, options).format(date);
}

/** The grouping and decimal separator characters a locale's number formatting uses. */
export function getNumberSymbols(locale: string): { group: string; decimal: string } {
  const parts = new Intl.NumberFormat(locale).formatToParts(1234567.8);
  return {
    group: parts.find((part) => part.type === "group")?.value ?? ",",
    decimal: parts.find((part) => part.type === "decimal")?.value ?? ".",
  };
}

/**
 * Renders an exact (already BigInt-scaled) integer/fraction digit pair with
 * the active locale's grouping and decimal separators. Kept distinct from
 * `formatNumber` because token amounts can exceed `Number.MAX_SAFE_INTEGER`
 * and must never round-trip through a float.
 */
export function formatDigitsForLocale(
  integerDigits: string,
  fractionDigits: string,
  locale: string = getActiveLocale(),
): string {
  const { group, decimal } = getNumberSymbols(locale);
  const groupedInteger = integerDigits.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  return fractionDigits ? `${groupedInteger}${decimal}${fractionDigits}` : groupedInteger;
}
