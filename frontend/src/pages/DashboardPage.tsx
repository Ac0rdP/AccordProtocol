import { useEffect, useRef, useState } from "react";
import { Plus, Repeat2 } from "lucide-react";
import type { RoleAccessBanner, WalletRole } from "../hooks/useRoles";
import type { DashboardStat, Owner, Proposal } from "../types/accord";
import { ProposalCard } from "../components/ProposalCard";
import { StatCard } from "../components/StatCard";
import { ProposalCardSkeleton } from "../components/ProposalCardSkeleton";
import { canCreate, missingRoleTooltip } from "../lib/soroban";

type DashboardPageProps = {
  activeProposals: Proposal[];
  owners: Owner[];
  dashboardStats: DashboardStat[];
  walletAddress: string | null;
  onApprove: (id: number) => void;
  onExecute: (id: number) => void;
  onRevoke: (id: number) => void;
  onCreateProposal: () => void;
  onCreateRecurringPayment: () => void;
  walletRoles: WalletRole[];
  roleBanner: RoleAccessBanner | null;
  loading: boolean;
  error: string | null;
};

export function DashboardPage({
  activeProposals,
  owners,
  dashboardStats,
  walletAddress,
  onApprove,
  onExecute,
  onRevoke,
  onCreateProposal,
  onCreateRecurringPayment,
  walletRoles,
  roleBanner,
  loading,
  error,
}: DashboardPageProps) {
  const readyCount = activeProposals.filter((p) => p.status === "ready").length;
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [sortByDeadline, setSortByDeadline] = useState(false);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [dismissedRoleBannerKey, setDismissedRoleBannerKey] = useState<string | null>(null);
  const prevReadyCount = useRef(readyCount);

  const displayedProposals = [...activeProposals].sort((left, right) => {
    if (!sortByDeadline) return right.id - left.id;
    return left.deadlineTs - right.deadlineTs;
  });

  useEffect(() => {
    if (readyCount > prevReadyCount.current) {
      setBannerDismissed(false);
    }
    prevReadyCount.current = readyCount;
  }, [readyCount]);

  useEffect(() => {
    setDismissedError(null);
  }, [error]);

  const showRoleBanner = Boolean(
    roleBanner && dismissedRoleBannerKey !== roleBanner.key
  );

  const roleBannerStyles = roleBanner?.variant === "unrecognized"
    ? "border-amber-500/20 bg-amber-500/10 text-amber-100"
    : "border-sky-500/20 bg-sky-500/10 text-sky-100";

  const createDisabledReason = walletAddress && !canCreate(walletRoles)
    ? missingRoleTooltip("create")
    : undefined;
  const createDisabled = Boolean(createDisabledReason);

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
        {dashboardStats.map((s) => (
          <StatCard key={s.label} label={s.label} value={s.value} sub={s.sub} />
        ))}
      </div>

      {error && !loading && dismissedError !== error && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 mb-6 text-sm text-red-400 flex items-center justify-between">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => {
                setDismissedError(error);
              }}
              className="underline hover:text-red-300 ml-4 shrink-0 focus:ring-2 focus:ring-zinc-400 focus:outline-none rounded"
            >
              Dismiss
            </button>
          </div>
        )}
      {showRoleBanner && roleBanner && (
        <div
          role="status"
          aria-live="polite"
          aria-label="Wallet role access"
          className={`mb-6 flex items-start justify-between rounded-xl border px-4 py-3 text-sm ${roleBannerStyles}`}
        >
          <div>
            <p className="font-medium text-white">{roleBanner.title}</p>
            <p className="mt-1 leading-5">{roleBanner.message}</p>
          </div>
          <button
            type="button"
            onClick={() => setDismissedRoleBannerKey(roleBanner.key)}
            aria-label="Dismiss role access message"
            className="ml-4 shrink-0 rounded hover:text-white focus:outline-none focus:ring-2 focus:ring-zinc-400"
          >
            ✕
          </button>
        </div>
      )}

      {readyCount > 0 && !bannerDismissed && (
        <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl px-4 py-3 mb-6 text-sm text-emerald-400 flex items-center justify-between">
          <span>
            {readyCount} {readyCount === 1 ? "proposal is" : "proposals are"} ready to execute.
          </span>
          <button
            type="button"
            onClick={() => setBannerDismissed(true)}
            aria-label="Dismiss"
            className="hover:text-emerald-300 ml-4 shrink-0 focus:ring-2 focus:ring-zinc-400 focus:outline-none rounded"
          >
            ✕
          </button>
        </div>
      )}
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold">Active Proposals</h2>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-sm text-zinc-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={sortByDeadline}
              onChange={(e) => setSortByDeadline(e.target.checked)}
              className="accent-emerald-500"
            />
            Expiring first
          </label>
          <button
            type="button"
            onClick={onCreateProposal}
            disabled={createDisabled}
            title={createDisabledReason}
            className="inline-flex items-center gap-1.5 text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-300 px-3 py-1.5 rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-zinc-800"
          >
            <Plus size={14} />
            New
          </button>
          <button
            type="button"
            onClick={onCreateRecurringPayment}
            disabled={createDisabled}
            title={createDisabledReason}
            className="inline-flex items-center gap-1.5 text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-300 px-3 py-1.5 rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-zinc-800"
          >
            <Repeat2 size={14} />
            Recurring
          </button>
        </div>
      </div>

      <div className="space-y-3">
        {loading ? (
          <>
            <ProposalCardSkeleton />
            <ProposalCardSkeleton />
          </>
        ) : activeProposals.length === 0 ? (
          <div className="text-center py-16 text-zinc-500 text-sm">
            <p className="font-semibold mb-2">No active proposals</p>
            <p>Create a new proposal to start the approval flow.</p>
          </div>
        ) : (
          displayedProposals.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              walletAddress={walletAddress}
              onApprove={onApprove}
              onExecute={onExecute}
              onRevoke={onRevoke}
              walletRoles={walletRoles}
            />
          ))
        )}
      </div>

      <div className="mt-8">
        <h2 className="font-semibold mb-4">Signers</h2>
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl divide-y divide-zinc-800">
          {owners.map((owner) => (
            <div
              key={owner.address}
              className="flex items-center justify-between px-4 py-3"
            >
              <div className="flex items-center gap-3">
                <div className="w-7 h-7 rounded-full bg-zinc-700 flex items-center justify-center text-xs text-zinc-400">
                  {owner.label[0]}
                </div>
                <span className="font-mono text-sm text-zinc-300">
                  {owner.address}
                </span>
              </div>
              {walletAddress &&
                owner.address
                  .replace("…", "...")
                  .startsWith(walletAddress.slice(0, 6)) && (
                  <span className="text-xs text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full">
                    you
                  </span>
                )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
