import type { ProposalStatus } from "../types/accord";

const STATUS_STYLES: Record<ProposalStatus, string> = {
  pending: "bg-yellow-500/10 text-yellow-400 border border-yellow-500/20",
  ready: "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20",
  executed: "bg-sky-500/10 text-sky-400 border border-sky-500/20",
  expired: "bg-zinc-500/10 text-zinc-500 border border-zinc-500/20",
  revoked: "bg-red-500/10 text-red-400 border border-red-500/20",
};

export function StatusBadge({ status }: { status: ProposalStatus }) {
  return (
    <span
      role="status"
      aria-label={`Status: ${status}`}
      className={`text-xs px-2 py-0.5 rounded-full font-mono ${STATUS_STYLES[status]}`}
    >
      {status}
    </span>
  );
}
