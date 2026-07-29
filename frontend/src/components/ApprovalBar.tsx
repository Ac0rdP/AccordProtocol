import React from "react";

type ApprovalBarProps = {
  approvalWeight: number; // current accumulated approval weight
  quorumWeight: number; // required quorum weight
  totalWeight: number; // total voting power
  label?: string;
};

export const ApprovalBar = React.memo(function ApprovalBar({ approvalWeight, quorumWeight, totalWeight, label }: ApprovalBarProps) {
  const percentOfQuorum = quorumWeight > 0 ? Math.min((approvalWeight / quorumWeight) * 100, 100) : 0;
  const quorumTickPct = totalWeight > 0 ? Math.min((quorumWeight / totalWeight) * 100, 100) : 0;

  const ariaLabel = label ?? `Approval weight ${approvalWeight} of required quorum ${quorumWeight}. ${Math.round(percentOfQuorum)} percent of quorum achieved.`;

  return (
    <div className="flex items-center gap-3 w-full" aria-label={ariaLabel}>
      <div className="relative flex-1 h-3 rounded-full bg-zinc-800 border border-zinc-700 overflow-hidden" role="img" aria-hidden>
        {/* Filled progress representing approval towards quorum (clamped to 100%) */}
        <div
          className="absolute left-0 top-0 bottom-0 bg-emerald-400"
          style={{ width: `${percentOfQuorum}%`, transition: "width 300ms ease" }}
        />

        {/* Quorum tick positioned relative to total voting power */}
        {totalWeight > 0 && (
          <div
            aria-hidden
            className="absolute top-0 bottom-0 w-px bg-amber-400/90"
            style={{ left: `${quorumTickPct}%` }}
            title={`Quorum at ${quorumWeight} / total ${totalWeight}`}
          />
        )}
      </div>

      <div className="flex-shrink-0 text-xs text-zinc-500 font-mono" aria-hidden>
        {approvalWeight} / {quorumWeight} weight
      </div>
    </div>
  );
});

