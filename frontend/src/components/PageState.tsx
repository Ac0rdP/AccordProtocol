import { useTranslation } from "react-i18next";

export type PageStateStatus = "loading" | "empty" | "error";

type PageStateProps = {
  status: PageStateStatus;
  title: string;
  description?: string;
  /** Shown as a Retry control when present and the state is an error. */
  onRetry?: () => void;
  retryLabel?: string;
};

/**
 * Shared loading / empty / error renderer used by every data-backed page.
 *
 * Routing all three states through one component keeps the user-visible copy,
 * accessibility semantics, and retry affordance identical across pages, and
 * gives the page-state matrix tests a single, stable contract to assert
 * against (`data-page-state`).
 */
export function PageState({
  status,
  title,
  description,
  onRetry,
  retryLabel,
}: PageStateProps) {
  const { t } = useTranslation();
  const isError = status === "error";
  const isLoading = status === "loading";
  const effectiveRetryLabel = retryLabel ?? t("common.retry");

  return (
    <div
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      aria-busy={isLoading || undefined}
      data-page-state={status}
      className="flex flex-col items-center justify-center py-16 text-center"
    >
      {isLoading && (
        <div
          aria-hidden="true"
          className="mb-4 h-6 w-6 animate-spin rounded-full border-2 border-zinc-700 border-t-emerald-500"
        />
      )}

      <p
        className={`font-semibold ${isError ? "text-red-400" : "text-zinc-300"}`}
      >
        {title}
      </p>

      {description && (
        <p className="mt-1 max-w-md px-4 text-sm text-zinc-600 dark:text-zinc-400">{description}</p>
      )}

      {isError && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-5 rounded-lg bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-zinc-400"
        >
          {effectiveRetryLabel}
        </button>
      )}
    </div>
  );
}
