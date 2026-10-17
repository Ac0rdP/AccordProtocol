import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  applyTheme,
  getStoredTheme,
  resolveTheme,
  subscribeToSystemTheme,
  THEME_STORAGE_KEY,
} from "./theme";

describe("theme utility", () => {
  let store: Record<string, string> = {};

  beforeEach(() => {
    store = {};
    const mockStorage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, val: string) => {
        store[key] = val;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        store = {};
      },
    };
    Object.defineProperty(window, "localStorage", {
      value: mockStorage,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, "localStorage", {
      value: mockStorage,
      writable: true,
      configurable: true,
    });
    document.documentElement.className = "";
    vi.restoreAllMocks();
  });

  it("defaults to system theme when no theme is stored", () => {
    expect(getStoredTheme()).toBe("system");
  });

  it("persists and retrieves chosen theme in localStorage", () => {
    applyTheme("light");
    expect(getStoredTheme()).toBe("light");
    expect(store[THEME_STORAGE_KEY]).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    applyTheme("dark");
    expect(getStoredTheme()).toBe("dark");
    expect(store[THEME_STORAGE_KEY]).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("correctly resolves system theme based on matchMedia", () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("dark"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    expect(resolveTheme("system")).toBe("dark");
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
  });

  it("subscribes and receives updates on system color scheme changes", () => {
    let changeHandler: ((e: { matches: boolean }) => void) | null = null;

    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn((event: string, handler: (e: { matches: boolean }) => void) => {
        if (event === "change") changeHandler = handler;
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    const callback = vi.fn();
    const unsubscribe = subscribeToSystemTheme(callback);

    expect(changeHandler).toBeTruthy();
    changeHandler!({ matches: true });
    expect(callback).toHaveBeenCalledWith("dark");

    changeHandler!({ matches: false });
    expect(callback).toHaveBeenCalledWith("light");

    unsubscribe();
  });
});
