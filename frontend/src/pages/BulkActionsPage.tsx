import { useMemo } from "react";
import type { Proposal } from "../types/accord";
import { BulkActionWorkflow } from "../components/BulkActionWorkflow";
import { PageState } from "../components/PageState";
import { eligibleProposals } from "../lib/bulkActions";

type BulkActionsPageProps = {
  proposals: Proposal[];
  walletAddress: string | null;
  onApprove: (id: number) => Promise<void>;
  onExecute: (id: number) => Promise<void>;
  onBatchComplete?: () => void;
  onConnectWallet?: () => void;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
};

/** Approve or execute several proposals in one guided batch. */
export function BulkActionsPage({
  proposals,
  walletAddress,
  onApprove,
  onExecute,
  onBatchComplete,
  onConnectWallet,
  loading = false,
  error = null,
  onRetry,
}: BulkActionsPageProps) {
  const counts = useMemo(
    () => ({
      approve: eligibleProposals(proposals, "approve").length,
      execute: eligibleProposals(proposals, "execute").length,
    }),
    [proposals],
  );

  let body;
  if (loading) {
    body = <PageState status="loading" title="Loading proposals for bulk actions…" />;
  } else if (error) {
    body = (
      <PageState
        status="error"
        title="Could not load proposals"
        description={error}
        onRetry={onRetry}
      />
    );
  } else if (counts.approve === 0 && counts.execute === 0) {
    body = (
      <PageState
        status="empty"
        title="No proposals ready for bulk actions"
        description="Pending proposals awaiting your approval and proposals that reached quorum will appear here."
      />
    );
  } else {
    body = (
      <BulkActionWorkflow
        proposals={proposals}
        walletAddress={walletAddress}
        onApprove={onApprove}
        onExecute={onExecute}
        onBatchComplete={onBatchComplete}
        onConnectWallet={onConnectWallet}
        initialAction={counts.execute > 0 ? "execute" : "approve"}
      />
    );
  }

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-white">Bulk actions</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Approve or execute several proposals in one guided batch, with a result for each.
        </p>
      </header>
      {body}
    </div>
  );
}
