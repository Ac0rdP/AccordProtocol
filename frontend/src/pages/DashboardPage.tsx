import type { DashboardStat, Owner, Proposal } from "../types/accord";
import { ProposalCard } from "../components/ProposalCard";
import { StatCard } from "../components/StatCard";
import { ProposalCardSkeleton } from "../components/ProposalCardSkeleton";

type DashboardPageProps = {
  activeProposals: Proposal[];
  owners: Owner[];
  dashboardStats: DashboardStat[];
  walletAddress: string | null;
  onApprove: (id: number) => void;
  onExecute: (id: number) => void;
  onRevoke: (id: number) => void;
  onCreateProposal: () => void;
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
  loading,
  error,
}: DashboardPageProps) {
  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
        {dashboardStats.map((s) => (
          <StatCard key={s.label} label={s.label} value={s.value} sub={s.sub} />
        ))}
      </div>
       
         {(error) && !loading && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 mb-6 text-sm text-red-400 flex items-center justify-between">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => {
               
              }}
              className="underline hover:text-red-300 ml-4 shrink-0"
            >
              Dismiss
            </button>
          </div>
        )}
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold">Active Proposals</h2>
        <button
          type="button"
          onClick={onCreateProposal}
          className="text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-300 px-3 py-1.5 rounded-lg transition-colors"
        >
          + New
        </button>
      </div>

      <div className="space-y-3">
        {loading ? (
          <>
            <ProposalCardSkeleton />
            <ProposalCardSkeleton />
          </>
        ) :  activeProposals.length === 0 ? (
          <div className="text-center py-16 text-zinc-500 text-sm">
            <p className="font-semibold mb-2">No active proposals</p>
           
          </div>
        ) : (
          activeProposals.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              walletAddress={walletAddress}
              onApprove={onApprove}
              onExecute={onExecute}
              onRevoke={onRevoke}
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
