import { useEffect, useState } from "react";
import type { Proposal } from "../types/accord";
import { ApprovalBar } from "./ApprovalBar";
import { StatusBadge } from "./StatusBadge";
import { Check, Copy, Link2 } from "lucide-react";

type ProposalCardProps = {
  proposal: Proposal;
  walletAddress: string | null;
  onApprove: (id: number) => void;
  onExecute: (id: number) => void;
  onRevoke: (id: number) => void;
};

export function ProposalCard({
  proposal,
  walletAddress,
  onApprove,
  onExecute,
  onRevoke,
}: ProposalCardProps) {
  const connected = !!walletAddress;
  const showApprove = proposal.status === "pending" && !proposal.userHasApproved;
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedProposer, setCopiedProposer] = useState(false);
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);

  useEffect(() => {
    if (!copiedLink) return;
    const timeout = window.setTimeout(() => setCopiedLink(false), 1500);
    return () => window.clearTimeout(timeout);
  }, [copiedLink]);

  useEffect(() => {
    if (!copiedProposer) return;
    const timeout = window.setTimeout(() => setCopiedProposer(false), 1500);
    return () => window.clearTimeout(timeout);
  }, [copiedProposer]);

  useEffect(() => {
    if (proposal.status !== "ready") {
      setAwaitingConfirmation(false);
    }
  }, [proposal.status]);

  const copyAddress = async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      setCopiedProposer(true);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const copyProposalLink = async () => {
    try {
      const proposalUrl = new URL(
        `/proposals/${proposal.id}`,
        window.location.origin
      ).toString();
      await navigator.clipboard.writeText(proposalUrl);
      setCopiedLink(true);
    } catch (err) {
      console.error("Failed to copy proposal link:", err);
    }
  };

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 hover:border-zinc-700 transition-colors">
      <div className="flex items-start justify-between mb-4">
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
              aria-label={
                copiedProposer
                  ? `Proposer address copied for proposal #${proposal.id}`
                  : `Copy proposer address for proposal #${proposal.id}`
              }
              className="rounded text-zinc-500 transition-colors hover:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-zinc-400"
              title={copiedProposer ? "Copied" : "Copy address"}
            >
              {copiedProposer ? (
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
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={copyProposalLink}
            aria-label={
              copiedLink
                ? `Proposal link copied for proposal #${proposal.id}`
                : `Copy proposal link for proposal #${proposal.id}`
            }
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-800 text-zinc-400 transition-colors hover:border-zinc-700 hover:text-white focus:outline-none focus:ring-2 focus:ring-zinc-400"
            title={copiedLink ? "Link copied" : "Copy proposal link"}
          >
            {copiedLink ? (
              <Check size={16} className="text-emerald-400" />
            ) : (
              <Link2 size={16} />
            )}
          </button>
          <StatusBadge status={proposal.status} />
        </div>
      </div>

      <div className="flex items-center justify-between mt-4">
        <ApprovalBar approvals={proposal.approvals} threshold={proposal.threshold} />

        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-600">{proposal.createdAt}</span>

          {showApprove && (
            <button
              type="button"
              onClick={() => onApprove(proposal.id)}
              aria-label={connected ? `Approve proposal #${proposal.id}` : `Connect and approve proposal #${proposal.id}`}
              className="text-xs bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1 rounded-lg transition-colors font-medium disabled:opacity-50 focus:ring-2 focus:ring-zinc-400 focus:outline-none"
            >
              {connected ? "Approve" : "Connect & Approve"}
            </button>
          )}

          {connected && proposal.userHasApproved && (proposal.status === "pending" || proposal.status === "ready") && (
            <button
              type="button"
              onClick={() => onRevoke(proposal.id)}
              aria-label={`Revoke approval for proposal #${proposal.id}`}
              className="text-xs bg-red-600 hover:bg-red-500 text-white px-3 py-1 rounded-lg transition-colors font-medium disabled:opacity-50 focus:ring-2 focus:ring-zinc-400 focus:outline-none"
            >
              Revoke
            </button>
          )}

          {connected && proposal.status === "ready" && !awaitingConfirmation && (
            <button
              type="button"
              aria-label={`Execute proposal #${proposal.id}`}
              className="text-xs bg-sky-600 hover:bg-sky-500 text-white px-3 py-1 rounded-lg transition-colors font-medium disabled:opacity-50 focus:ring-2 focus:ring-zinc-400 focus:outline-none"
              onClick={() => setAwaitingConfirmation(true)}
            >
              Execute
            </button>
          )}

          {connected && proposal.status === "ready" && awaitingConfirmation && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-400">Send this transaction?</span>
              <button
                type="button"
                onClick={() => {
                  onExecute(proposal.id);
                  setAwaitingConfirmation(false);
                }}
                className="text-xs bg-sky-600 hover:bg-sky-500 text-white px-3 py-1 rounded-lg transition-colors font-medium"
              >
                Confirm
              </button>
              <button
                type="button"
                onClick={() => setAwaitingConfirmation(false)}
                className="text-xs bg-zinc-700 hover:bg-zinc-600 text-white px-3 py-1 rounded-lg transition-colors font-medium"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
