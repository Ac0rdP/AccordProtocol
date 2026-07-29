import React, { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { Proposal, ProposalCategory, ProposalKind } from "../types/accord";
import { ApprovalBar } from "./ApprovalBar";
import { StatusBadge } from "./StatusBadge";
import { Check, Copy, Link2 } from "lucide-react";
import { shortenAddr } from "../lib/soroban";

type ProposalCardProps = {
  proposal: Proposal;
  walletAddress: string | null;
  onApprove: (id: number) => void;
  onExecute: (id: number) => void;
  onRevoke: (id: number) => void;
  // weight-based props (new)
  approvalWeight?: number;
  quorumWeight?: number;
  totalWeight?: number;
  ownerWeights?: Record<string, number>;
};

const KIND_LABELS: Record<ProposalKind, { title: string; badge: string }> = {
  transfer: { title: "Send", badge: "Transfer" },
  add_owner: { title: "Add Owner", badge: "Governance" },
  remove_owner: { title: "Remove Owner", badge: "Governance" },
  change_threshold: { title: "Change Threshold", badge: "Governance" },
  set_spending_limit: { title: "Set Spending Limit", badge: "Spending Limit" },
  change_owner_weight: { title: "Change Owner Weight", badge: "Governance" },
};

// Colour palette per category, mirroring the pill styling used by StatusBadge.
const CATEGORY_STYLES: Record<ProposalCategory, string> = {
  transfer: "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20",
  payroll: "bg-violet-500/10 text-violet-400 border border-violet-500/20",
  grant: "bg-amber-500/10 text-amber-400 border border-amber-500/20",
  ops: "bg-sky-500/10 text-sky-400 border border-sky-500/20",
  other: "bg-zinc-500/10 text-zinc-400 border border-zinc-500/20",
};

function KindSummary({ proposal }: { proposal: Proposal }): ReactNode {
  const { kind } = proposal;

  switch (kind) {
    case "transfer":
      return (
        <>
          <Link
            to={`/proposals/${proposal.id}`}
            className="font-semibold text-white transition-colors hover:text-emerald-300 focus:outline-none focus:ring-2 focus:ring-zinc-400 rounded"
          >
            Send {proposal.amount} {proposal.token}
          </Link>
          <p className="text-zinc-500 text-sm font-mono mt-0.5">
            →{" "}
            <span className="inline-block max-w-[180px] truncate align-bottom">
              {proposal.to}
            </span>
          </p>
        </>
      );
    case "add_owner":
      return (
        <>
          <Link
            to={`/proposals/${proposal.id}`}
            className="font-semibold text-white transition-colors hover:text-emerald-300 focus:outline-none focus:ring-2 focus:ring-zinc-400 rounded"
          >
            Add Owner
          </Link>
          <p className="text-zinc-500 text-sm font-mono mt-0.5">
            New owner →{" "}
            <span className="inline-block max-w-[180px] truncate align-bottom">
              {proposal.to}
            </span>
          </p>
        </>
      );
    case "remove_owner":
      return (
        <>
          <Link
            to={`/proposals/${proposal.id}`}
            className="font-semibold text-white transition-colors hover:text-emerald-300 focus:outline-none focus:ring-2 focus:ring-zinc-400 rounded"
          >
            Remove Owner
          </Link>
          <p className="text-zinc-500 text-sm font-mono mt-0.5">
            Remove →{" "}
            <span className="inline-block max-w-[180px] truncate align-bottom">
              {proposal.to}
            </span>
          </p>
        </>
      );
    case "change_threshold":
      return (
        <>
          <Link
            to={`/proposals/${proposal.id}`}
            className="font-semibold text-white transition-colors hover:text-emerald-300 focus:outline-none focus:ring-2 focus:ring-zinc-400 rounded"
          >
            Change Threshold
          </Link>
          <p className="text-zinc-500 text-sm font-mono mt-0.5">
            Require → {proposal.to}
          </p>
        </>
      );
    case "set_spending_limit":
      return (
        <>
          <Link
            to={`/proposals/${proposal.id}`}
            className="font-semibold text-white transition-colors hover:text-emerald-300 focus:outline-none focus:ring-2 focus:ring-zinc-400 rounded"
          >
            Set Spending Limit
          </Link>
          <p className="text-zinc-500 text-sm font-mono mt-0.5">
            Owner →{" "}
            <span className="inline-block max-w-[180px] truncate align-bottom">
              {proposal.to}
            </span>
            , Limit → {proposal.amount} {proposal.token}
          </p>
        </>
      );
  }
}

export const ProposalCard = React.memo(function ProposalCard({
  proposal,
  walletAddress,
  onApprove,
  onExecute,
  onRevoke,
  approvalWeight = 0,
  quorumWeight = 0,
  totalWeight = 0,
  ownerWeights = {},
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
      <div className="flex items-start justify-between mb-4 gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <p className="text-xs text-zinc-500 font-mono">
              Proposal #{proposal.id}
            </p>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-800 text-zinc-400 font-mono">
              {KIND_LABELS[proposal.kind].badge}
            </span>
          </div>
          <KindSummary proposal={proposal} />
          <div className="flex items-center gap-2 mt-0.5">
            <div className="flex items-center gap-2">
              <p className="text-zinc-500 text-sm font-mono">
                Proposed by → {shortenAddr(proposal.proposer)}
              </p>
              {(() => {
                // Find full owner address that matches the shortened proposer string
                const ownerAddr = Object.keys(ownerWeights).find((a) => shortenAddr(a) === proposal.proposer);
                if (ownerAddr) {
                  return (
                    <span className="text-xs text-zinc-400 ml-1">· weight {ownerWeights[ownerAddr]}</span>
                  );
                }
                return null;
              })()}
            </div>

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
          <Link
            to={`/proposals/${proposal.id}`}
            className="mt-2 inline-flex text-xs font-medium text-emerald-400 transition-colors hover:text-emerald-300 focus:outline-none focus:ring-2 focus:ring-zinc-400 rounded"
          >
            View details
          </Link>
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
          <span
            role="note"
            aria-label={`Category: ${proposal.category}`}
            className={`text-xs px-2 py-0.5 rounded-full font-mono capitalize ${CATEGORY_STYLES[proposal.category]}`}
          >
            {proposal.category}
          </span>
          <StatusBadge status={proposal.status} />
        </div>
      </div>

      <div className="flex items-center justify-between mt-4">
        <ApprovalBar
          approvalWeight={approvalWeight ?? 0}
          quorumWeight={quorumWeight ?? proposal.threshold}
          totalWeight={totalWeight ?? 0}
        />

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
});
