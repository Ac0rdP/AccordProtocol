import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Check, Copy, Link2, ShieldAlert } from "lucide-react";
import { canApprove, canExecute, formatWeightPercent, missingRoleTooltip, shortenAddr } from "../lib/soroban";
import type { Proposal, ProposalCategory, ProposalKind } from "../types/accord";
import { ApprovalBar } from "./ApprovalBar";
import { StatusBadge } from "./StatusBadge";

type ProposalCardProps = {
  proposal: Proposal;
  walletAddress: string | null;
  onApprove: (id: number) => void;
  onExecute: (id: number) => void;
  onRevoke: (id: number) => void;
  walletRoles: readonly string[];
  ownerWeights?: Record<string, number>;
  propApprovalWeight?: number;
  propQuorumWeight?: number;
  propTotalWeight?: number;
};

const KIND_LABELS: Record<ProposalKind, { title: string; badge: string }> = {
  transfer: { title: "Transfer", badge: "Payment" },
  add_owner: { title: "Add Owner", badge: "Governance" },
  remove_owner: { title: "Remove Owner", badge: "Governance" },
  change_threshold: { title: "Change Threshold", badge: "Governance" },
  set_spending_limit: { title: "Set Spending Limit", badge: "Spending Limit" },
  change_owner_weight: { title: "Change Weight", badge: "Governance" },
  grant_role: { title: "Grant Role", badge: "Governance" },
  revoke_role: { title: "Revoke Role", badge: "Governance" },
  recurring: { title: "Recurring Payment", badge: "Recurring" },
};

const GOVERNANCE_KINDS = new Set<ProposalKind>([
  "add_owner",
  "remove_owner",
  "change_owner_weight",
  "grant_role",
  "revoke_role",
]);

const CATEGORY_STYLES: Record<ProposalCategory, string> = {
  Transfer: "bg-sky-900/50 text-sky-300",
  Payroll: "bg-violet-900/50 text-violet-300",
  Grant: "bg-emerald-900/50 text-emerald-300",
  Ops: "bg-amber-900/50 text-amber-300",
  Other: "bg-zinc-800 text-zinc-400",
};

type KindSummaryProps = {
  proposal: Proposal;
  ownerWeights?: Record<string, number>;
};

function formatStroops(rawAmount: string): string {
  const digits = rawAmount.trim();
  if (!/^-?\d+$/.test(digits)) return digits;
  const sign = digits.startsWith("-") ? "-" : "";
  const unsigned = sign ? digits.slice(1) : digits;
  return `${sign}${unsigned.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

function KindSummary({ proposal, ownerWeights = {} }: KindSummaryProps) {
  switch (proposal.kind) {
    case "transfer":
      return (
        <Link to={`/proposals/${proposal.id}`} className="block" aria-label={`Send ${proposal.amount} ${proposal.token}`}>
          <p className="text-sm text-zinc-300">Send {proposal.amount} {proposal.token}</p>
          {proposal.rawAmount !== undefined && (
            <p className="mt-0.5 font-mono text-xs text-zinc-500">{formatStroops(proposal.rawAmount)} stroops</p>
          )}
          <p className="mt-0.5 font-mono text-sm text-zinc-500">To {proposal.to}</p>
        </Link>
      );
    case "add_owner":
      return <p className="mt-0.5 font-mono text-sm text-zinc-500">Owner {proposal.to}</p>;
    case "remove_owner":
      return <p className="mt-0.5 font-mono text-sm text-zinc-500">Owner {proposal.to}</p>;
    case "change_threshold":
      return <p className="mt-0.5 text-sm text-zinc-500">New threshold: {proposal.to}</p>;
    case "set_spending_limit":
      return (
        <>
          <p className="mt-0.5 font-mono text-sm text-zinc-500">Owner {proposal.to}</p>
          <p className="text-sm text-zinc-500">Limit {proposal.amount} for {proposal.token}</p>
        </>
      );
    case "change_owner_weight": {
      const newWeight = Number(proposal.amount || 0);
      const quorumWeight = proposal.quorumWeight ?? 0;
      const totalWeight = proposal.totalWeight ?? 0;
      const fullAddress = Object.keys(ownerWeights).find((addr) => shortenAddr(addr) === proposal.to) ?? null;
      const currentWeight = fullAddress ? ownerWeights[fullAddress] ?? 0 : null;
      const projectedTotal = currentWeight !== null ? totalWeight - currentWeight + newWeight : totalWeight;
      const quorumPctOfTotal = totalWeight > 0 ? quorumWeight / totalWeight : 0;
      const projectedQuorum = Math.round(quorumPctOfTotal * projectedTotal);

      return (
        <>
          <p className="mt-0.5 text-sm text-zinc-300">
            Change <span className="font-mono">{proposal.to}</span>
            {"'s weight from "}
            <span className="font-semibold text-zinc-200">{currentWeight !== null ? currentWeight : "?"}</span>
            {" to "}
            <span className="font-semibold text-emerald-400">{newWeight}</span>
          </p>

          {quorumWeight > 0 && totalWeight > 0 && (
            <div className="mt-2 rounded-lg border border-zinc-700/60 bg-zinc-800/40 px-3 py-2 text-xs space-y-1">
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-zinc-400">Quorum Impact</p>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-zinc-500">Current quorum</p>
                  <p className="font-mono text-zinc-300">
                    {quorumWeight} wt <span className="text-zinc-500">({formatWeightPercent(quorumWeight, totalWeight)})</span>
                  </p>
                </div>
                <span className="text-zinc-600">→</span>
                <div className="text-right">
                  <p className="text-zinc-500">After change</p>
                  <p className={`font-mono ${projectedQuorum > quorumWeight ? "text-amber-400" : projectedQuorum < quorumWeight ? "text-sky-400" : "text-zinc-300"}`}>
                    {projectedQuorum} wt <span className="text-zinc-500">({formatWeightPercent(projectedQuorum, projectedTotal)})</span>
                  </p>
                </div>
              </div>
            </div>
          )}
        </>
      );
    }
    case "grant_role":
      return <p className="mt-0.5 text-sm text-zinc-500">Grant role to {proposal.to}</p>;
    case "revoke_role":
      return <p className="mt-0.5 text-sm text-zinc-500">Revoke role from {proposal.to}</p>;
    case "recurring":
      return <p className="mt-0.5 text-sm text-zinc-500">Recurring payment to {proposal.to}</p>;
    default:
      return null;
  }
}

export function ProposalCard({
  proposal,
  walletAddress,
  onApprove,
  onExecute,
  onRevoke,
  walletRoles,
  ownerWeights = {},
  propApprovalWeight,
  propQuorumWeight,
  propTotalWeight,
}: ProposalCardProps) {
  const connected = !!walletAddress;
  const showApprove = proposal.status === "pending" && !proposal.userHasApproved;
  const approveDisabledReason = connected && !canApprove(walletRoles) ? missingRoleTooltip("approve") : undefined;
  const executeDisabledReason = connected && !canExecute(walletRoles) ? missingRoleTooltip("execute") : undefined;
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedProposer, setCopiedProposer] = useState(false);
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);
  const labels = KIND_LABELS[proposal.kind] ?? KIND_LABELS.transfer;

  const effectiveProposal: Proposal = {
    ...proposal,
    approvalWeight: propApprovalWeight ?? proposal.approvalWeight ?? 0,
    quorumWeight: propQuorumWeight ?? proposal.quorumWeight ?? proposal.threshold,
    totalWeight: propTotalWeight ?? proposal.totalWeight ?? 0,
  };

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
      const proposalUrl = new URL(`/proposals/${proposal.id}`, window.location.origin).toString();
      await navigator.clipboard.writeText(proposalUrl);
      setCopiedLink(true);
    } catch (err) {
      console.error("Failed to copy proposal link:", err);
    }
  };

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 transition-colors hover:border-zinc-700">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <p className="mb-1 font-mono text-xs text-zinc-500">Proposal #{proposal.id}</p>
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold text-white">{labels.title}</p>
            <span className="rounded-md border border-zinc-800 px-2 py-0.5 text-xs text-zinc-400">{labels.badge}</span>
          </div>

          <KindSummary proposal={effectiveProposal} ownerWeights={ownerWeights} />

          <div className="mt-0.5 flex items-center gap-2">
            <div className="flex items-center gap-2">
              <p className="font-mono text-sm text-zinc-500">Proposed by → {shortenAddr(proposal.proposer)}</p>
              {(() => {
                const ownerAddr = Object.keys(ownerWeights).find((a) => shortenAddr(a) === proposal.proposer);
                if (ownerAddr) {
                  return <span className="ml-1 text-xs text-zinc-400">· weight {ownerWeights[ownerAddr]}</span>;
                }
                return null;
              })()}
            </div>

            <button
              type="button"
              onClick={() => copyAddress(proposal.proposer)}
              aria-label={copiedProposer ? `Proposer address copied for proposal #${proposal.id}` : `Copy proposer address for proposal #${proposal.id}`}
              className="rounded text-zinc-500 transition-colors hover:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-zinc-400"
              title={copiedProposer ? "Copied" : "Copy address"}
            >
              {copiedProposer ? <Check size={16} className="text-green-500" /> : <Copy size={16} />}
            </button>
          </div>

          {proposal.description && <p className="mt-1.5 max-w-sm text-xs leading-relaxed text-zinc-500">{proposal.description}</p>}

          <Link to={`/proposals/${proposal.id}`} className="mt-2 inline-flex rounded text-xs font-medium text-emerald-400 transition-colors hover:text-emerald-300 focus:outline-none focus:ring-2 focus:ring-zinc-400">
            View details
          </Link>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={copyProposalLink}
            aria-label={copiedLink ? `Proposal link copied for proposal #${proposal.id}` : `Copy proposal link for proposal #${proposal.id}`}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-800 text-zinc-400 transition-colors hover:border-zinc-700 hover:text-white focus:outline-none focus:ring-2 focus:ring-zinc-400"
            title={copiedLink ? "Link copied" : "Copy proposal link"}
          >
            {copiedLink ? <Check size={16} className="text-emerald-400" /> : <Link2 size={16} />}
          </button>
          {GOVERNANCE_KINDS.has(proposal.kind) && (
            <span role="note" aria-label="Governance Impact" className="inline-flex items-center gap-1 rounded-full border border-orange-500/30 bg-gradient-to-r from-orange-500/20 to-amber-500/20 px-2.5 py-0.5 text-[11px] font-semibold tracking-wide text-orange-300 shadow-[0_0_6px_rgba(251,146,60,0.15)]">
              <ShieldAlert size={12} className="shrink-0" />
              Governance Impact
            </span>
          )}
          {proposal.category && (
            <span role="note" aria-label={`Category: ${proposal.category}`} className={`rounded-full px-2 py-0.5 text-xs font-mono capitalize ${CATEGORY_STYLES[proposal.category] ?? "bg-zinc-800 text-zinc-400"}`}>
              {proposal.category}
            </span>
          )}
          <StatusBadge status={proposal.status} />
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between">
        <ApprovalBar
          approvals={effectiveProposal.approvals}
          threshold={effectiveProposal.threshold}
          approverAddresses={effectiveProposal.approverAddresses}
          approverWeights={effectiveProposal.approverWeights}
          approvalWeight={effectiveProposal.approvalWeight ?? 0}
          quorumWeight={effectiveProposal.quorumWeight ?? effectiveProposal.threshold}
          totalWeight={effectiveProposal.totalWeight ?? 0}
        />

        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-600">{proposal.createdAt}</span>

          {showApprove && (
            <button
              type="button"
              onClick={() => onApprove(proposal.id)}
              disabled={Boolean(approveDisabledReason)}
              title={approveDisabledReason}
              aria-label={connected ? `Approve proposal #${proposal.id}` : `Connect and approve proposal #${proposal.id}`}
              className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-zinc-400 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-emerald-600"
            >
              {connected ? "Approve" : "Connect & Approve"}
            </button>
          )}

          {connected && proposal.userHasApproved && (proposal.status === "pending" || proposal.status === "ready") && (
            <button
              type="button"
              onClick={() => onRevoke(proposal.id)}
              aria-label={`Revoke approval for proposal #${proposal.id}`}
              className="rounded-lg bg-red-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-red-500 focus:outline-none focus:ring-2 focus:ring-zinc-400 disabled:opacity-50"
            >
              Revoke
            </button>
          )}

          {connected && proposal.status === "ready" && (!awaitingConfirmation || executeDisabledReason) && (
            <button
              type="button"
              aria-label={`Execute proposal #${proposal.id}`}
              disabled={Boolean(executeDisabledReason)}
              title={executeDisabledReason}
              className="rounded-lg bg-sky-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-sky-500 focus:outline-none focus:ring-2 focus:ring-zinc-400 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-sky-600"
              onClick={() => setAwaitingConfirmation(true)}
            >
              Execute
            </button>
          )}

          {connected && proposal.status === "ready" && awaitingConfirmation && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-400">Send this transaction?</span>
              <button type="button" onClick={() => { onExecute(proposal.id); setAwaitingConfirmation(false); }} className="rounded-lg bg-sky-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-sky-500">
                Confirm
              </button>
              <button type="button" onClick={() => setAwaitingConfirmation(false)} className="rounded-lg bg-zinc-700 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-zinc-600">
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
