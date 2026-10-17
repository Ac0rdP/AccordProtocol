export type ThemeChoice = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

export const THEME_STORAGE_KEY = "accord_theme";
export const LEGACY_THEME_STORAGE_KEY = "theme";

export function getStoredTheme(): ThemeChoice {
  try {
    const stored =
      localStorage.getItem(THEME_STORAGE_KEY) ||
      localStorage.getItem(LEGACY_THEME_STORAGE_KEY);
    if (stored === "dark" || stored === "light" || stored === "system") {
      return stored;
    }
  } catch {
    // localStorage might be unavailable or throw in restricted environments
  }
  return "system";
}

export function getSystemTheme(): ResolvedTheme {
  if (
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  ) {
    return "dark";
  }
  return "light";
}

export function resolveTheme(choice: ThemeChoice): ResolvedTheme {
  if (choice === "system") {
    return getSystemTheme();
  }
  return choice;
}

export function applyTheme(choice: ThemeChoice): ResolvedTheme {
  const resolved = resolveTheme(choice);
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    if (resolved === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
  }
  try {
    localStorage.setItem(THEME_STORAGE_KEY, choice);
    localStorage.setItem(LEGACY_THEME_STORAGE_KEY, choice);
  } catch {
    // ignore storage errors
  }
  return resolved;
}

export function subscribeToSystemTheme(
  callback: (resolved: ResolvedTheme) => void,
): () => void {
  if (typeof window === "undefined" || !window.matchMedia) {
    return () => {};
  }

  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  const listener = (e: MediaQueryListEvent) => {
    callback(e.matches ? "dark" : "light");
  };

  if (mql.addEventListener) {
    mql.addEventListener("change", listener);
    return () => mql.removeEventListener("change", listener);
  } else if (mql.addListener) {
    // Safari <14 fallback
    mql.addListener(listener);
    return () => mql.removeListener(listener);
  }
  return () => {};
}
