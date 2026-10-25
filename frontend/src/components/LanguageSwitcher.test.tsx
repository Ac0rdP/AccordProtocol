import React from "react";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { LanguageSwitcher } from "./LanguageSwitcher";
import i18n from "../i18n";

function installStorage() {
  const store: Record<string, string> = {};
  const mock = {
    getItem: (key: string) => (key in store ? store[key] : null),
    setItem: (key: string, value: string) => {
      store[key] = String(value);
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      for (const key of Object.keys(store)) delete store[key];
    },
  };
  Object.defineProperty(window, "localStorage", { value: mock, writable: true, configurable: true });
  Object.defineProperty(globalThis, "localStorage", { value: mock, writable: true, configurable: true });
  return mock;
}

describe("LanguageSwitcher", () => {
  beforeEach(() => {
    installStorage();
  });

  afterEach(async () => {
    await i18n.changeLanguage("en");
    localStorage.clear();
    cleanup();
  });

  it("renders every supported language and reflects the active one", () => {
    render(<LanguageSwitcher />);

    const select = screen.getByRole("combobox", { name: "Language" }) as HTMLSelectElement;
    expect(select.value).toBe("en");
    expect(screen.getByRole("option", { name: "English" })).toBeDefined();
    expect(screen.getByRole("option", { name: "Español" })).toBeDefined();
    expect(screen.getByRole("option", { name: "العربية" })).toBeDefined();
  });

  it("changes the i18n language and persists the choice", async () => {
    render(<LanguageSwitcher className="extra" />);

    const select = screen.getByRole("combobox", { name: "Language" });
    fireEvent.change(select, { target: { value: "es" } });

    await waitFor(() => expect(i18n.language).toBe("es"));
    expect(localStorage.getItem("accord_language")).toBe("es");
    expect(select.className).toContain("extra");
  });
});
