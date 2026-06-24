import { useState } from "react";
import type { Proposal } from "../types/accord";
import { ApprovalBar } from "./ApprovalBar";
import { StatusBadge } from "./StatusBadge";
import { Copy, Check } from "lucide-react";

type ProposalCardProps = {
  proposal: Proposal;
  walletAddress: string | null;
  onApprove: (id: number) => void;
  onExecute: (id: number) => void;
};

export function ProposalCard({
  proposal,
  walletAddress,
  onApprove,
  onExecute,
}: ProposalCardProps) {
  const connected = !!walletAddress;

  // Logic to copy the address to clipboard and show a temporary "copied/checked" icon
  const [copied, setCopied] = useState(false);

  const copyAddress = async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);

      setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 hover:border-zinc-700 transition-colors">
      <div className="flex items-start justify-between mb-3">
        <div>
          <p className="text-xs text-zinc-500 font-mono mb-1">
            Proposal #{proposal.id}
          </p>
          <p className="text-white font-semibold">
            Send {proposal.amount} {proposal.token}
          </p>
          <p className="text-zinc-500 text-sm font-mono mt-0.5">
            → {proposal.to}
          </p>
          {/* The proposer's address */}
          <div className="flex items-center gap-2 mt-0.5">
            <p className="text-zinc-500 text-sm font-mono">
              Proposed by → {proposal.proposer.slice(0, 6)}...
              {proposal.proposer.slice(-4)}
            </p>

            <button
              type="button"
              onClick={() => copyAddress(proposal.proposer)}
              className="text-zinc-500 hover:text-zinc-700 transition-colors cursor-pointer"
              title={copied ? "Copied!" : "Copy address"}
            >
              {copied ? (
                <Check size={16} className="text-green-500" />
              ) : (
                <Copy size={16} />
              )}
            </button>
          </div>
          {proposal.description && (
            <p className="text-zinc-500 text-xs mt-1.5 leading-relaxed max-w-sm">
              {proposal.description}
            </p>
          )}
        </div>
        <StatusBadge status={proposal.status} />
      </div>

      <div className="flex items-center justify-between mt-4">
        <ApprovalBar approvals={proposal.approvals} threshold={proposal.threshold} />

        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-600">{proposal.createdAt}</span>

          {proposal.status === "pending" && (
            <button
              type="button"
              onClick={() => onApprove(proposal.id)}
              title={connected ? undefined : "Connect wallet to approve"}
              className="text-xs bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1 rounded-lg transition-colors font-medium disabled:opacity-50"
            >
              {connected ? "Approve" : "Connect & Approve"}
            </button>
          )}

          {proposal.status === "ready" && (
            <button
              type="button"
              onClick={() => onExecute(proposal.id)}
              title={connected ? undefined : "Connect wallet to execute"}
              className="text-xs bg-sky-600 hover:bg-sky-500 text-white px-3 py-1 rounded-lg transition-colors font-medium disabled:opacity-50"
            >
              {connected ? "Execute" : "Connect & Execute"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
