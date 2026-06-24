export function ApprovalBar({ approvals, threshold }: { approvals: number; threshold: number }) {
  return (
    <div className="flex items-center gap-2" aria-label={`${approvals} of ${threshold} approvals`}>
      <div className="flex gap-1">
        {Array.from({ length: threshold }).map((_, i) => (
          <div
            key={i}
            className={`w-2 h-2 rounded-full ${i < approvals ? "bg-emerald-400" : "bg-zinc-700"}`}
          />
        ))}
      </div>
      <span className="text-xs text-zinc-500 font-mono">
        {approvals}/{threshold}
      </span>
    </div>
  );
}
