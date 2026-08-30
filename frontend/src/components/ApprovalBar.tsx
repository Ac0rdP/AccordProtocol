import React from "react";

type ApprovalBarProps = {
  approvals: number;
  threshold: number;
  approverAddresses?: string[];
};

export const ApprovalBar = React.memo(function ApprovalBar({
  approvals,
  threshold,
}: ApprovalBarProps) {
  const safeThreshold = Math.max(threshold, 0);
  const safeApprovals = Math.max(approvals, 0);
  const fillPercent =
    safeThreshold === 0
      ? 0
      : Math.min(safeApprovals / safeThreshold, 1) * 100;
  const ariaValueNow = Math.min(safeApprovals, safeThreshold);

  return (
    <div className="flex items-center gap-3 min-w-0" aria-label={`${approvals} of ${threshold} approvals`}>
      <div
        role="progressbar"
        aria-label="Approval progress"
        aria-valuemin={0}
        aria-valuemax={safeThreshold}
        aria-valuenow={ariaValueNow}
        className="h-2 w-24 overflow-hidden rounded-full bg-zinc-800 sm:w-32"
      >
        <div
          data-testid="approval-bar-fill"
          className="h-full rounded-full bg-emerald-400 transition-[width] duration-200"
          style={{ width: `${fillPercent}%` }}
        />
      </div>
      <span className="shrink-0 text-xs font-mono text-zinc-500 tabular-nums">
        {approvals}/{threshold}
      </span>
    </div>
  );
});
