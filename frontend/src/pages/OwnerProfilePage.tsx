import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Check, Copy, ArrowLeft } from "lucide-react";
import { EmptyState } from "../components/EmptyState";
import { ProposalCard } from "../components/ProposalCard";
import { EditableOwnerLabel } from "../components/EditableOwnerLabel";
import type { Owner, Proposal, Role } from "../types/accord";
import { aggregateOwnerActivity, addressesMatch } from "../lib/ownerActivity";

type OwnerProfilePageProps = {
  proposals: Proposal[];
  owners: Owner[];
  walletAddress?: string | null;
  walletRoles?: readonly string[];
  onApprove?: (id: number) => void;
  onExecute?: (id: number) => void;
  onRevoke?: (id: number) => void;
};

const ROLE_STYLES: Record<Role, string> = {
  Owner: "border-emerald-500/20 bg-emerald-500/10 text-emerald-300",
  Viewer: "border-sky-500/20 bg-sky-500/10 text-sky-300",
  Guardian: "border-amber-500/20 bg-amber-500/10 text-amber-300",
  SpendingLimit: "border-violet-500/20 bg-violet-500/10 text-violet-300",
  Proposer: "border-emerald-500/20 bg-emerald-500/10 text-emerald-300",
  Approver: "border-sky-500/20 bg-sky-500/10 text-sky-300",
  Executor: "border-fuchsia-500/20 bg-fuchsia-500/10 text-fuchsia-300",
};

export function OwnerProfilePage({
  proposals,
  owners,
  walletAddress,
  walletRoles = [],
  onApprove = () => {},
  onExecute = () => {},
  onRevoke = () => {},
}: OwnerProfilePageProps) {
  const { address = "" } = useParams<{ address: string }>();
  const [activeTab, setActiveTab] = useState<"created" | "approved">("created");
  const [copied, setCopied] = useState(false);
  const [labelOverride, setLabelOverride] = useState<string | null>(null);

  const decodedAddress = decodeURIComponent(address);

  // Match owner details from multisig owners list
  const ownerRecord = useMemo(
    () => owners.find((o) => addressesMatch(o.fullAddress, decodedAddress)),
    [owners, decodedAddress],
  );

  const displayLabel = labelOverride ?? ownerRecord?.label ?? "Owner Profile";

  const activity = useMemo(
    () => aggregateOwnerActivity(decodedAddress, proposals),
    [decodedAddress, proposals],
  );

  const displayedProposals =
    activeTab === "created"
      ? activity.createdProposals
      : activity.approvedProposals;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(decodedAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // noop
    }
  };

  return (
    <div>
      {/* Navigation breadcrumb */}
      <div className="mb-6">
        <Link
          to="/app/owners"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-zinc-400 hover:text-white transition-colors"
        >
          <ArrowLeft size={16} className="rtl:-scale-x-100" />
          Back to Owners
        </Link>
      </div>

      {/* Owner Header Card */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5 sm:p-6 mb-8">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="h-12 w-12 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center text-emerald-400 font-semibold text-lg shrink-0">
              {displayLabel[0]}
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2 mb-1">
                {ownerRecord ? (
                  <EditableOwnerLabel
                    address={ownerRecord.fullAddress}
                    label={displayLabel}
                    onSaved={setLabelOverride}
                    className="text-xl font-semibold text-white"
                  />
                ) : (
                  <h1 className="text-xl font-semibold text-white">{displayLabel}</h1>
                )}
                {typeof ownerRecord?.weight === "number" && (
                  <span className="rounded-md border border-zinc-700 bg-zinc-800/80 px-2 py-0.5 text-xs font-mono text-zinc-300">
                    Weight {ownerRecord.weight}
                  </span>
                )}
              </div>

              {/* Address with copy button */}
              <div className="flex items-center gap-2">
                <p className="font-mono text-xs sm:text-sm text-zinc-400 break-all">
                  {decodedAddress}
                </p>
                <button
                  type="button"
                  onClick={handleCopy}
                  title="Copy full address"
                  className="rounded p-1 text-zinc-500 hover:text-zinc-200 transition-colors"
                >
                  {copied ? (
                    <Check size={14} className="text-emerald-400" />
                  ) : (
                    <Copy size={14} />
                  )}
                </button>
              </div>

              {/* Roles */}
              {ownerRecord?.roles && ownerRecord.roles.length > 0 && (
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {ownerRecord.roles.map((role) => (
                    <span
                      key={role}
                      className={`rounded-md border px-2 py-0.5 text-xs font-medium ${
                        ROLE_STYLES[role] ?? "border-zinc-700 text-zinc-300"
                      }`}
                    >
                      {role}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Summary Metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <p className="text-xs text-zinc-400 font-medium">Proposals Created</p>
          <p className="mt-1 font-mono text-2xl font-semibold text-white">
            {activity.createdCount}
          </p>
          <p className="text-xs text-zinc-500 mt-0.5">Author of proposals</p>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <p className="text-xs text-zinc-400 font-medium">Proposals Approved</p>
          <p className="mt-1 font-mono text-2xl font-semibold text-emerald-400">
            {activity.approvedCount}
          </p>
          <p className="text-xs text-zinc-500 mt-0.5">Signatures submitted</p>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <p className="text-xs text-zinc-400 font-medium">Total Activity</p>
          <p className="mt-1 font-mono text-2xl font-semibold text-sky-400">
            {activity.totalCount}
          </p>
          <p className="text-xs text-zinc-500 mt-0.5">Proposals & approvals</p>
        </div>
      </div>

      {/* Proposals Section */}
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-semibold text-white">Activity History</h2>

        {/* Tab switch */}
        <div className="inline-flex rounded-lg border border-zinc-800 bg-zinc-900 p-1">
          <button
            type="button"
            onClick={() => setActiveTab("created")}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              activeTab === "created"
                ? "bg-zinc-700 text-white"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            Created ({activity.createdCount})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("approved")}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              activeTab === "approved"
                ? "bg-zinc-700 text-white"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            Approved ({activity.approvedCount})
          </button>
        </div>
      </div>

      {/* Activity List or Empty State */}
      {!activity.hasActivity ? (
        <EmptyState
          title="No activity recorded"
          description="This owner has not created or approved any proposals yet."
        />
      ) : displayedProposals.length === 0 ? (
        <EmptyState
          title={
            activeTab === "created"
              ? "No proposals created"
              : "No proposals approved"
          }
          description={
            activeTab === "created"
              ? "This owner has not created any proposals."
              : "This owner has not signed or approved any proposals."
          }
        />
      ) : (
        <div className="space-y-3">
          {displayedProposals.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              walletAddress={walletAddress ?? null}
              walletRoles={walletRoles}
              onApprove={onApprove}
              onExecute={onExecute}
              onRevoke={onRevoke}
            />
          ))}
        </div>
      )}
    </div>
  );
}
