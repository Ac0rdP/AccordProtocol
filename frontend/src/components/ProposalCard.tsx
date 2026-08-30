import { useEffect, useState } from "react";
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
  ownerWeights?: Record<string, number>;
};

const KIND_LABELS: Record<Exclude<ProposalKind, "recurring">, { title: string; badge: string }> & {
  recurring: { title: string; badge: string };
} = {
  transfer: { title: "Transfer", badge: "Payment" },
  add_owner: { title: "Add Owner", badge: "Governance" },
  remove_owner: { title: "Remove Owner", badge: "Governance" },
  change_threshold: { title: "Change Threshold", badge: "Governance" },
  set_spending_limit: { title: "Set Spending Limit", badge: "Policy" },
  change_owner_weight: { title: "Change Weight", badge: "Governance" },
  recurring: { title: "Recurring Payment", badge: "Payment" },
};

const CATEGORY_STYLES: Record<ProposalCategory, string> = {
  Transfer: "bg-sky-900/50 text-sky-300",
  Payroll: "bg-violet-900/50 text-violet-300",
  Grant: "bg-emerald-900/50 text-emerald-300",
  Ops: "bg-amber-900/50 text-amber-300",
  Other: "bg-zinc-800 text-zinc-400",
};

function KindSummary({ proposal }: { proposal: Proposal }) {
  switch (proposal.kind) {
    case "transfer":
      return (
        <Link
          to={`/proposals/${proposal.id}`}
          className="block"
          aria-label={`Send ${proposal.amount} ${proposal.token}`}
        >
          <p className="text-sm text-zinc-300">
            Send {proposal.amount} {proposal.token}
          </p>
          
          {/* NAN NE RAWAMOUNT */}
          {proposal.rawAmount && proposal.rawAmount !== "-" && (
            <p className="mt-0.5 font-mono text-xs text-zinc-600">
              Raw: {proposal.rawAmount} stroops
            </p>
          )}
          
          <p className="mt-0.5 font-mono text-sm text-zinc-500">
            To {proposal.to}
          </p>
        </Link>
      );
    case "add_owner":
      return (
        <p className="mt-0.5 font-mono text-sm text-zinc-500">
          Owner {proposal.to}
        </p>
      );
    case "remove_owner":
      return (
        <p className="mt-0.5 font-mono text-sm text-zinc-500">
          Owner {proposal.to}
        </p>
      );
    case "change_threshold":
      return (
        <p className="mt-0.5 text-sm text-zinc-500">
          New threshold: {proposal.to}
        </p>
      );
    case "set_spending_limit":
      return (
        <>
          <p className="mt-0.5 font-mono text-sm text-zinc-500">
            Owner {proposal.to}
          </p>
          <p className="text-sm text-zinc-500">
            Limit {proposal.amount} for {proposal.token}
                   <p className="text-sm text-zinc-500">
            Limit {proposal.amount} for {proposal.token}
          </p>
          {proposal.rawAmount && proposal.rawAmount!== "-" && (
            <p className="font-mono text-xs text-zinc-600">
              Raw: {proposal.rawAmount}
            </p>
          )}
        </>
      );
    case "change_owner_weight":
      return (
        <>
          <p className="mt-0.5 font-mono text-sm text-zinc-500">
            Owner {proposal.to}
          </p>
          <p className="text-sm text-zinc-500">
            New weight: {proposal.amount}
          </p>
        </>
      );
    case "recurring":
      return (
        <p className="mt-0.5 text-sm text-zinc-500">
          Recurring payment to {proposal.to}
        </p>
      );
    default: {
      const _: never = proposal.kind;
      return null;
    }
  }
}

export function ProposalCard({
  proposal,
  walletAddress,
  onApprove,
  onExecute,
  onRevoke,
  ownerWeights = {},
}: ProposalCardProps) {
  const connected =!!walletAddress;
  const showApprove = proposal.status === "pending" &&!proposal.userHasApproved;
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedProposer, setCopiedProposer] = useState(false);
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);
  const labels = KIND_LABELS[proposal.kind];

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
    if (proposal.status!== "ready") {
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
    <div className="bg-zinc-900 border-zinc-800 rounded-xl p-4 hover:border-zinc-700 transition-colors">
      <div className="flex items-start justify-between mb-4">
        <div>
          <p className="text-xs text-zinc-500 font-mono mb-1">
            Proposal #{proposal.id}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-white font-semibold">{labels.title}</p>
            <span className="rounded-md border-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
              {labels.badge}
            </span>
          </div>

          <KindSummary proposal={proposal} />

          <div className="flex items-center gap-2 mt-0.5">
            <div className="flex items-center gap-2">
              <p className="text-zinc-500 text-sm font-mono">
                Proposed by → {shortenAddr(proposal.proposer)}
              </p>
              {(() => {
                const ownerAddr = Object.keys(ownerWeights).find(
                  (a) => shortenAddr(a) === proposal.proposer
                );
                if (ownerAddr) {
                  return (
                    <span className="text-xs text-zinc-400 ml-1">
                      · weight {ownerWeights[ownerAddr]}
                    </span>
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
              title={copiedProposer? "Copied" : "Copy address"}
            >
              {copiedProposer? (
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
            title={copiedLink? "Link copied" : "Copy proposal link"}
          >
            {copiedLink? (
              <Check size={16} className="text-emerald-400" />
            ) : (
              <Link2 size={16} />
            )}
          </button>
          {proposal.category && (
            <span
              role="note"
              aria-label={`Category: ${proposal.category}`}
              className={`text-xs px-2 py-0.5 rounded-full font-mono capitalize ${
                CATEGORY_STYLES[proposal.category]?? "bg-zinc-800 text-zinc-400"
              }`}
            >
              {proposal.category}
            </span>
          )}
          <StatusBadge status={proposal.status} />
        </div>
      </div>

      <div className="flex items-center justify-between mt-4">
        <ApprovalBar
          approvalWeight={proposal.approvalWeight?? 0}
          quorumWeight={proposal.quorumWeight?? proposal.threshold}
          totalWeight={proposal.totalWeight?? 0}
        />

        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-600">{proposal.createdAt}</span>

          {showApprove && (
            <button
              type="button"
              onClick={() => onApprove(proposal.id)}
              aria-label={
                connected
                ? `Approve proposal #${proposal.id}`
                  : `Connect and approve proposal #${proposal.id}`
              }
              className="text-xs bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1 rounded-lg transition-colors font-medium disabled:opacity-50 focus:ring-2 focus:ring-zinc-400 focus:outline-none"
            >
              {connected? "Approve" : "Connect & Approve"}
            </button>
          )}

          {connected &&
            proposal.userHasApproved &&
            (proposal.status === "pending" || proposal.status === "ready") && (
              <button
                type="button"
                onClick={() => onRevoke(proposal.id)}
                aria-label={`Revoke approval for proposal #${proposal.id}`}
                className="text-xs bg-red-600 hover:bg-red-500 text-white px-3 py-1 rounded-lg transition-colors font-medium disabled:opacity-50 focus:ring-2 focus:ring-zinc-400 focus:outline-none"
              >
                Revoke
              </button>
            )}

          {connected && proposal.status === "ready" &&!awaitingConfirmation && (
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
