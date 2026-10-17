import { Laptop, Moon, Sun } from "lucide-react";
import type { ThemeChoice } from "../lib/theme";

interface ThemeControlProps {
  currentTheme: ThemeChoice;
  onThemeChange: (theme: ThemeChoice) => void;
  className?: string;
}

const THEME_OPTIONS: Array<{
  value: ThemeChoice;
  label: string;
  icon: typeof Sun;
}> = [
  { value: "light", label: "Light", icon: Sun },
  { value: "system", label: "System", icon: Laptop },
  { value: "dark", label: "Dark", icon: Moon },
];

/**
 * Explicit theme control allowing users to pick Light, Dark, or System mode.
 */
export function ThemeControl({
  currentTheme,
  onThemeChange,
  className = "",
}: ThemeControlProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Theme selection"
      data-testid="theme-control"
      className={`inline-flex items-center rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-100 dark:bg-zinc-900 p-0.5 text-xs ${className}`}
    >
      {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
        const isSelected = currentTheme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={isSelected}
            aria-label={`${label} theme`}
            title={`Use ${label} theme`}
            data-testid={`theme-option-${value}`}
            onClick={() => onThemeChange(value)}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-400 ${
              isSelected
                ? "bg-white dark:bg-zinc-800 text-zinc-900 dark:text-white shadow-xs"
                : "text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200"
            }`}
          >
            <Icon size={13} className="shrink-0" aria-hidden="true" />
            <span className="hidden sm:inline">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
