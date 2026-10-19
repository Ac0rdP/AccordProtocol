type ErrorStateProps = {
  message: string;
  /** Optional retry handler — renders an accessible Retry button when set. */
  onRetry?: () => void;
  /** Optional dismiss handler. */
  onDismiss?: () => void;
  variant?: "page" | "banner" | "section";
};

/**
 * Shared error presentation with optional retry / dismiss actions.
 */
export function ErrorState({
  message,
  onRetry,
  onDismiss,
  variant = "page",
}: ErrorStateProps) {
  if (variant === "banner") {
    return (
      <div
        role="alert"
        className="mb-6 flex items-center justify-between gap-3 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400"
      >
        <span>{message}</span>
        <div className="flex shrink-0 items-center gap-3">
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="underline hover:text-red-300 focus:outline-none focus:ring-2 focus:ring-zinc-400 rounded"
            >
              Retry
            </button>
          )}
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss error"
              className="underline hover:text-red-300 focus:outline-none focus:ring-2 focus:ring-zinc-400 rounded"
            >
              Dismiss
            </button>
          )}
        </div>
      </div>
    );
  }

  const padding = variant === "page" ? "py-16" : "py-6";

  return (
    <div
      role="alert"
      className={`flex flex-col items-center justify-center gap-3 text-center ${padding}`}
    >
      <p className="max-w-md text-sm text-red-400">{message}</p>
      <div className="flex items-center gap-3">
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-lg bg-zinc-800 px-4 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-zinc-400"
          >
            Retry
          </button>
        )}
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss error"
            className="rounded-lg bg-zinc-800 px-4 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-zinc-400"
          >
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}
