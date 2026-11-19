import type { Proposal } from "../types/accord";

/** The two contract actions that can be applied to several proposals at once. */
export type BulkActionKind = "approve" | "execute";

export type BulkItemStatus = "queued" | "running" | "succeeded" | "failed" | "skipped";

export type BulkItemResult = {
  id: number;
  status: BulkItemStatus;
  /** User-facing reason, set when `status` is "failed" or "skipped". */
  error?: string;
};

export type BulkSummary = {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
};

export const BULK_ACTION_LABELS: Record<BulkActionKind, { verb: string; past: string }> = {
  approve: { verb: "Approve", past: "approved" },
  execute: { verb: "Execute", past: "executed" },
};

/**
 * Whether a proposal can take part in a bulk action.
 *
 * - approve: still pending and not yet approved by the connected wallet.
 * - execute: has reached quorum (status "ready").
 */
export function isBulkEligible(proposal: Proposal, action: BulkActionKind): boolean {
  if (action === "approve") {
    return proposal.status === "pending" && !proposal.userHasApproved;
  }
  return proposal.status === "ready";
}

export function eligibleProposals(
  proposals: Proposal[],
  action: BulkActionKind,
): Proposal[] {
  return proposals
    .filter((proposal) => isBulkEligible(proposal, action))
    .sort((a, b) => a.id - b.id);
}

/**
 * Callers are expected to throw already user-facing messages (App wraps the
 * submit helpers with `mapSubmissionError`); this only normalises the shape.
 */
function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Transaction failed";
}

export function initialResults(ids: number[]): BulkItemResult[] {
  return ids.map((id) => ({ id, status: "queued" }));
}

/**
 * Runs `perform` for each id **sequentially** (each one needs its own wallet
 * signature and account sequence number) and reports progress after every
 * transition. A failure never stops the batch; the item is marked failed and
 * the run moves on. Aborting through `signal` marks the remaining items as
 * skipped once the in-flight item settles.
 */
export async function runBulkAction(
  ids: number[],
  perform: (id: number) => Promise<void>,
  onUpdate: (results: BulkItemResult[]) => void,
  signal?: AbortSignal,
): Promise<BulkItemResult[]> {
  let results = initialResults(ids);
  const update = (index: number, patch: Partial<BulkItemResult>) => {
    results = results.map((item, i) => (i === index ? { ...item, ...patch } : item));
    onUpdate(results);
  };

  onUpdate(results);

  for (let index = 0; index < ids.length; index += 1) {
    if (signal?.aborted) {
      update(index, { status: "skipped", error: "Stopped before this item ran" });
      continue;
    }

    update(index, { status: "running" });
    try {
      await perform(ids[index]);
      update(index, { status: "succeeded" });
    } catch (error) {
      update(index, { status: "failed", error: describeError(error) });
    }
  }

  return results;
}

export function summarizeResults(results: BulkItemResult[]): BulkSummary {
  return results.reduce<BulkSummary>(
    (summary, item) => {
      if (item.status === "succeeded") summary.succeeded += 1;
      if (item.status === "failed") summary.failed += 1;
      if (item.status === "skipped") summary.skipped += 1;
      return summary;
    },
    { total: results.length, succeeded: 0, failed: 0, skipped: 0 },
  );
}

/** Ids worth re-running: anything that failed or never got to run. */
export function retryableIds(results: BulkItemResult[]): number[] {
  return results
    .filter((item) => item.status === "failed" || item.status === "skipped")
    .map((item) => item.id);
}
