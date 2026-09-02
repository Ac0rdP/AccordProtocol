import React from "react";

export type ApprovalBarProps = {
  approvalWeight?: number;
  quorumWeight?: number;
  totalWeight?: number;
  approvals?: number;
  threshold?: number;
  approverAddresses?: string[];
  approverWeights?: Record<string, number>;
  label?: string;
};

export const ApprovalBar = React.memo(function ApprovalBar({
  approvals = 0,
  threshold = 0,
  approverAddresses = [],
  approverWeights = {},
}: ApprovalBarProps) {
  return (
    <div className="flex items-center gap-2" aria-label={`${approvals} of ${threshold} approvals`}>
      <div className="flex gap-1">
        {Array.from({ length: threshold }).map((_, i) => {
          const isApproved = i < approvals;
          
          let tooltipTitle = undefined;
          if (isApproved && approverAddresses[i]) {
            const addr = approverAddresses[i];
            const weight = approverWeights[addr];
            const weightStr = weight !== undefined ? ` · weight ${weight}` : "";
            tooltipTitle = `${addr.slice(0, 6)}...${addr.slice(-4)}${weightStr}`;
          }

          return (
            <div
              key={i}
              title={tooltipTitle} // Native HTML tooltip
              className={`w-2 h-2 rounded-full ${
                isApproved ? "bg-emerald-400" : "bg-zinc-700"
              }`}
            />
          );
        })}
      </div>
      <span className="text-xs text-zinc-500 font-mono">
        {approvals}/{threshold}
      </span>
    </div>
  );
});
