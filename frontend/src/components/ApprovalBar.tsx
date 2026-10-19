import React from "react";
import { Link, useInRouterContext } from "react-router-dom";

function ApproverDotLink({
  to,
  title,
  ariaLabel,
  className,
}: {
  to: string;
  title?: string;
  ariaLabel?: string;
  className?: string;
}) {
  const inRouter = useInRouterContext();
  if (inRouter) {
    return <Link to={to} title={title} aria-label={ariaLabel} className={className} />;
  }
  return <a href={to} title={title} aria-label={ariaLabel} className={className} />;
}

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
  approvalWeight = 0,
  quorumWeight = 0,
  totalWeight = 0,
  approvals = 0,
  threshold = 0,
  approverAddresses = [],
  approverWeights = {},
}: ApprovalBarProps) {
  const displayApprovalWeight = approvalWeight || approvals;
  const displayQuorumWeight = quorumWeight || threshold || 0;
  const barLength = Math.max(0, totalWeight || threshold || displayQuorumWeight || 0);

  return (
    <div className="flex items-center gap-2" aria-label={`${displayApprovalWeight} / ${displayQuorumWeight} weight`}>
      <div className="flex gap-1">
        {Array.from({ length: barLength }).map((_, i) => {
          const isApproved = i < approvals;

          if (isApproved && approverAddresses[i]) {
            const addr = approverAddresses[i];
            const weight = approverWeights[addr];
            const weightStr = weight !== undefined ? ` · weight ${weight}` : "";
            const tooltipTitle = `${addr.slice(0, 6)}...${addr.slice(-4)}${weightStr}`;

            return (
              <ApproverDotLink
                key={i}
                to={`/app/owners/${encodeURIComponent(addr)}`}
                title={tooltipTitle}
                ariaLabel={`View profile for approver ${addr.slice(0, 6)}...${addr.slice(-4)}`}
                className="w-2 h-2 rounded-full bg-emerald-400 hover:ring-2 hover:ring-emerald-300 transition-all cursor-pointer"
              />
            );
          }

          return (
            <div
              key={i}
              className={`w-2 h-2 rounded-full ${
                isApproved ? "bg-emerald-400" : "bg-zinc-700"
              }`}
            />
          );
        })}
      </div>
      <span className="text-xs text-zinc-500 font-mono">
        {displayApprovalWeight} / {displayQuorumWeight} weight
      </span>
    </div>
  );
});
