import { describe, expect, it } from "vitest";
import i18n, { getTextDirection, SUPPORTED_LANGUAGES } from "./index";
import en from "./locales/en/translation.json";
import es from "./locales/es/translation.json";
import ar from "./locales/ar/translation.json";

function getKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      keys.push(...getKeys(value as Record<string, unknown>, full));
    } else {
      keys.push(full);
    }
  }
  return keys;
}

describe("i18n and RTL layout", () => {
  it("defines RTL and LTR text directions correctly", () => {
    expect(getTextDirection("ar")).toBe("rtl");
    expect(getTextDirection("he")).toBe("rtl");
    expect(getTextDirection("fa")).toBe("rtl");
    expect(getTextDirection("ur")).toBe("rtl");
    expect(getTextDirection("en")).toBe("ltr");
    expect(getTextDirection("es")).toBe("ltr");
    expect(getTextDirection("fr")).toBe("ltr");
  });

  it("updates documentElement dir and lang when language changes to Arabic", async () => {
    await i18n.changeLanguage("ar");
    expect(document.documentElement.dir).toBe("rtl");
    expect(document.documentElement.lang).toBe("ar");

    await i18n.changeLanguage("en");
    expect(document.documentElement.dir).toBe("ltr");
    expect(document.documentElement.lang).toBe("en");
  });

  it("contains all required translation keys symmetrically across en, es, and ar", () => {
    const enKeys = getKeys(en);
    const esKeys = getKeys(es);
    const arKeys = getKeys(ar);

    expect(enKeys.length).toBeGreaterThan(0);
    expect(arKeys).toEqual(enKeys);
    expect(esKeys).toEqual(enKeys);
  });

  it("supports all declared languages", () => {
    const codes = SUPPORTED_LANGUAGES.map((l) => l.code);
    expect(codes).toContain("en");
    expect(codes).toContain("es");
    expect(codes).toContain("ar");
  });
});
