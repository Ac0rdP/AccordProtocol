type ApprovalBarProps = {
  approvals: number;
  threshold: number;
  approverAddresses?: string[];
};

export function ApprovalBar({ approvals, threshold, approverAddresses = [] }: ApprovalBarProps) {
  return (
    <div className="flex items-center gap-2" aria-label={`${approvals} of ${threshold} approvals`}>
      <div className="flex gap-1">
        {Array.from({ length: threshold }).map((_, i) => {
          const isApproved = i < approvals;
          
          // Truncate the address if this dot represents an approval
          let tooltipTitle = undefined;
          if (isApproved && approverAddresses[i]) {
            const addr = approverAddresses[i];
            tooltipTitle = `${addr.slice(0, 6)}...${addr.slice(-4)}`;
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
}