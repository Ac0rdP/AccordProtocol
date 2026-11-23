type LoadingStateProps = {
  /** Accessible status message announced to assistive tech. */
  message?: string;
  /** Visual density — page centers in the viewport; inline stays compact. */
  variant?: "page" | "inline" | "section";
};

/**
 * Shared loading placeholder used across pages for consistent, accessible
 * pending states.
 */
export function LoadingState({
  message = "Loading…",
  variant = "page",
}: LoadingStateProps) {
  const sizing =
    variant === "page"
      ? "py-16"
      : variant === "section"
        ? "py-6"
        : "py-3";

  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={`${sizing} text-center text-sm text-zinc-600 dark:text-zinc-400`}
    >
      <span className="inline-flex items-center gap-2">
        <svg
          className="h-4 w-4 animate-spin text-zinc-400"
          fill="none"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          />
        </svg>
        {message}
      </span>
    </div>
  );
}
