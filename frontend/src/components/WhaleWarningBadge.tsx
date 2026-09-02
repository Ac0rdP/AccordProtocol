export interface WhaleWarningBadgeProps {
  triggered?: boolean;
  sharePct?: number;
  thresholdPct?: number;
  message?: string;
}

export function WhaleWarningBadge({
  triggered = false,
  sharePct,
  thresholdPct = 50,
  message,
}: WhaleWarningBadgeProps) {
  if (!triggered) {
    return (
      <div
        role="status"
        aria-label="No whale warning active"
        className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700/50 bg-zinc-800/40 px-2.5 py-1 text-xs text-zinc-400 font-mono"
      >
        <span className="h-2 w-2 rounded-full bg-zinc-500" />
        <span>Balanced Voting Power</span>
      </div>
    );
  }

  const defaultMsg = sharePct
    ? `Whale Warning: Single owner controls ${sharePct}% of voting power (exceeds ${thresholdPct}% threshold)`
    : "Whale Warning: High concentration of voting power in a single owner";

  return (
    <div
      role="alert"
      aria-label="Whale warning active"
      className="inline-flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-300 shadow-sm"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 20 20"
        fill="currentColor"
        className="h-4 w-4 shrink-0 text-amber-400"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
          clipRule="evenodd"
        />
      </svg>
      <span>{message || defaultMsg}</span>
    </div>
  );
}
