import type { ReactNode } from "react";

type AnalyticsSectionStateProps = {
  loading: boolean;
  error: string | null;
  empty: boolean;
  emptyMessage: string;
  onRetry?: () => void;
  children: ReactNode;
};

/**
 * Shared loading/empty/error wrapper for analytics charts and stat cards, so
 * every section renders these states identically instead of each component
 * inventing its own placeholder markup.
 */
export function AnalyticsSectionState({
  loading,
  error,
  empty,
  emptyMessage,
  onRetry,
  children,
}: AnalyticsSectionStateProps) {
  if (loading) {
    return (
      <div className="h-48 flex items-center justify-center animate-pulse">
        <div className="text-zinc-500 text-sm">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-48 flex flex-col items-center justify-center gap-3">
        <div className="text-red-400 text-sm text-center px-4">{error}</div>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="text-sm px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors focus:ring-2 focus:ring-zinc-400 focus:outline-none"
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  if (empty) {
    return (
      <div className="h-48 flex items-center justify-center">
        <div className="text-zinc-500 text-sm text-center px-4">
          {emptyMessage}
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
