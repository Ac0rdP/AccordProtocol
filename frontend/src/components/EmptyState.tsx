import type { ReactNode } from "react";

type EmptyStateProps = {
  title: string;
  description?: string;
  /** Optional primary action (e.g. "Create proposal"). */
  action?: ReactNode;
  /** Optional decorative icon rendered above the title. */
  icon?: ReactNode;
  variant?: "page" | "section";
};

/**
 * Shared empty-state layout used when a page or section has nothing to show.
 */
export function EmptyState({
  title,
  description,
  action,
  icon,
  variant = "page",
}: EmptyStateProps) {
  const padding = variant === "page" ? "py-16 sm:py-20" : "py-6";

  return (
    <div
      role="status"
      aria-live="polite"
      className={`text-center ${padding}`}
    >
      {icon && (
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-zinc-800 text-zinc-600 dark:text-zinc-400">
          {icon}
        </div>
      )}
      <h3 className="mb-1 text-sm font-semibold text-zinc-300">{title}</h3>
      {description && (
        <p className="mx-auto mb-5 max-w-md text-sm text-zinc-600 dark:text-zinc-400">
          {description}
        </p>
      )}
      {action}
    </div>
  );
}
