/**
 * Cookbook recipes for common Accord flows: create, approve, execute,
 * recurring payments and treasury analytics. Each recipe is a small, typed
 * composition of `AccordClient` calls that checks preconditions before
 * spending fees, so it doubles as runnable documentation (see the README
 * "Cookbook" section).
 *
 * Recipes depend only on the client's method shape (`CookbookClient`), so they
 * run unchanged against `AccordClient` or the `MockAccordContract` test
 * harness. `AccordClient` is imported as a type only and is not bundled.
 */

import type { AccordClient } from "./client.js";
import { AccordValidationError } from "./errors.js";
import type {
  CreateRecurringParams,
  Proposal,
  ProposalApprovalProgress,
  ProposalCategory,
  ProposalStatus,
  Transfer,
} from "./types.js";

/** The subset of `AccordClient` the recipes call. */
export type CookbookClient = Pick<
  AccordClient,
  | "createProposal"
  | "createRecurringProposal"
  | "approve"
  | "execute"
  | "hasApproved"
  | "getProposal"
  | "getProposalApprovalProgress"
  | "getProposalsPaged"
  | "getTotalProposals"
  | "getTimeLockDelay"
  | "getOwners"
  | "getThreshold"
  | "getTotalWeight"
  | "getActiveRecurringCount"
>;

export interface ProposeTransferParams {
  proposer: string;
  transfers: Transfer[];
  description: string;
  /** Unix seconds after which the proposal expires. */
  deadline: bigint;
  category?: ProposalCategory;
}

export interface ProposalReceipt {
  txHash: string;
  /**
   * Id read back from `getTotalProposals` after submission. Ids are allocated
   * sequentially, so this is exact unless another proposal lands in between;
   * confirm against the `proposal_created` event when that matters.
   */
  proposalId: bigint;
}

export interface ApprovalOutcome {
  approved: { approver: string; txHash: string }[];
  skipped: { approver: string; reason: "already-approved" | "quorum-reached" }[];
  progress: ProposalApprovalProgress;
  quorumReached: boolean;
}

export interface ExecuteOptions {
  /** Current Unix time in seconds (default: the local clock). */
  now?: bigint;
}

function unixNow(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

async function receipt(client: CookbookClient, txHash: string): Promise<ProposalReceipt> {
  return { txHash, proposalId: await client.getTotalProposals() };
}

/** Recipe: create a transfer proposal and return its id. */
export async function proposeTransfer(
  client: CookbookClient,
  params: ProposeTransferParams
): Promise<ProposalReceipt> {
  if (!Array.isArray(params.transfers) || params.transfers.length === 0) {
    throw new AccordValidationError("transfers", "At least one transfer is required.");
  }
  const txHash = await client.createProposal(
    params.proposer,
    params.transfers,
    params.description,
    params.deadline,
    params.category ?? "Transfer"
  );
  return receipt(client, txHash);
}

/**
 * Recipe: collect approvals in order until the proposal's quorum weight is
 * met. Approvers who already signed are skipped, as is everyone after quorum,
 * so no fee is spent on approvals that cannot change the outcome.
 */
export async function approveUntilQuorum(
  client: CookbookClient,
  proposalId: bigint | number,
  approvers: string[]
): Promise<ApprovalOutcome> {
  if (!Array.isArray(approvers) || approvers.length === 0) {
    throw new AccordValidationError("approvers", "At least one approver is required.");
  }

  const outcome: ApprovalOutcome = {
    approved: [],
    skipped: [],
    progress: await client.getProposalApprovalProgress(proposalId),
    quorumReached: false,
  };

  for (const approver of approvers) {
    if (outcome.progress.approval_weight >= outcome.progress.quorum_weight) {
      outcome.skipped.push({ approver, reason: "quorum-reached" });
      continue;
    }
    if (await client.hasApproved(proposalId, approver)) {
      outcome.skipped.push({ approver, reason: "already-approved" });
      continue;
    }
    outcome.approved.push({ approver, txHash: await client.approve(approver, proposalId) });
    outcome.progress = await client.getProposalApprovalProgress(proposalId);
  }

  outcome.quorumReached = outcome.progress.approval_weight >= outcome.progress.quorum_weight;
  return outcome;
}

/**
 * Recipe: execute a proposal once it is Ready and its time-lock has elapsed.
 * Throws `AccordValidationError` (field `proposalId`) instead of submitting a
 * transaction that the contract would reject.
 */
export async function executeWhenReady(
  client: CookbookClient,
  executor: string,
  proposalId: bigint | number,
  options: ExecuteOptions = {}
): Promise<string> {
  const proposal = await client.getProposal(proposalId);
  if (proposal.status !== "Ready") {
    throw new AccordValidationError("proposalId", `Proposal ${proposal.id} is ${proposal.status}, not Ready.`);
  }

  const executableAt = proposal.ready_at + (await client.getTimeLockDelay());
  const now = options.now ?? unixNow();
  if (now < executableAt) {
    throw new AccordValidationError(
      "proposalId",
      `Proposal ${proposal.id} is time-locked until ${executableAt} (${executableAt - now}s from now).`
    );
  }

  return client.execute(executor, proposalId);
}

export interface LifecycleParams extends ProposeTransferParams {
  approvers: string[];
  executor: string;
  now?: bigint;
}

export interface LifecycleResult {
  proposal: ProposalReceipt;
  approvals: ApprovalOutcome;
  /** Present only when the proposal reached quorum and had no active time-lock. */
  executeTxHash?: string;
}

/**
 * Recipe: run create → approve → execute end-to-end. Stops after approvals
 * when quorum is not reached or a time-lock is configured, leaving execution
 * to a later `executeWhenReady` call.
 */
export async function runTransferLifecycle(
  client: CookbookClient,
  params: LifecycleParams
): Promise<LifecycleResult> {
  const proposal = await proposeTransfer(client, params);
  const approvals = await approveUntilQuorum(client, proposal.proposalId, params.approvers);
  const result: LifecycleResult = { proposal, approvals };

  if (approvals.quorumReached && (await client.getTimeLockDelay()) === 0n) {
    result.executeTxHash = await executeWhenReady(client, params.executor, proposal.proposalId, {
      now: params.now,
    });
  }
  return result;
}

const MIN_INTERVAL_SECS = 60n;
const MAX_INTERVAL_SECS = 365n * 24n * 60n * 60n;

/**
 * Checks a recurring schedule against the contract's bounds (`InvalidInterval`,
 * `InvalidCap`, `InvalidSchedule`) before it is proposed.
 */
export function validateRecurringParams(params: CreateRecurringParams): void {
  if (params.amount <= 0n) {
    throw new AccordValidationError("params.amount", "Amount must be strictly positive.");
  }
  if (params.interval_secs < MIN_INTERVAL_SECS || params.interval_secs > MAX_INTERVAL_SECS) {
    throw new AccordValidationError("params.interval_secs", "Interval must be between 60 seconds and 365 days.");
  }
  if (params.total_cap !== 0n && params.total_cap < params.amount) {
    throw new AccordValidationError("params.total_cap", "Cap must be 0 (uncapped) or at least the per-period amount.");
  }
  if (params.end_time !== 0n && params.end_time <= params.start_time) {
    throw new AccordValidationError("params.end_time", "End time must be 0 (open-ended) or after the start time.");
  }
  if (params.cliff_time !== 0n && params.cliff_time < params.start_time) {
    throw new AccordValidationError("params.cliff_time", "Cliff must be 0 or at/after the start time.");
  }
}

export interface ProposeRecurringParams {
  proposer: string;
  schedule: CreateRecurringParams;
  description: string;
  deadline: bigint;
  category?: ProposalCategory;
}

/**
 * Recipe: propose a recurring payment. The schedule becomes active once the
 * proposal is approved and executed like any other proposal.
 */
export async function proposeRecurringPayment(
  client: CookbookClient,
  params: ProposeRecurringParams
): Promise<ProposalReceipt> {
  validateRecurringParams(params.schedule);
  const txHash = await client.createRecurringProposal(
    params.proposer,
    params.schedule,
    params.description,
    params.deadline,
    params.category ?? "Payroll"
  );
  return receipt(client, txHash);
}

export interface ProposalSummary {
  total: number;
  byStatus: Partial<Record<ProposalStatus, number>>;
  byCategory: Partial<Record<ProposalCategory, number>>;
  /** Sum of transfer amounts per token across all transfer proposals. */
  requestedByToken: Record<string, bigint>;
  /** Sum of transfer amounts per token across executed proposals only. */
  executedByToken: Record<string, bigint>;
  /** Executed ÷ settled (executed, expired or revoked); 0 when nothing settled. */
  executionRate: number;
}

/** Recipe (analytics): aggregate proposals by status, category and token. */
export function summarizeProposals(proposals: Proposal[]): ProposalSummary {
  const summary: ProposalSummary = {
    total: proposals.length,
    byStatus: {},
    byCategory: {},
    requestedByToken: {},
    executedByToken: {},
    executionRate: 0,
  };

  for (const p of proposals) {
    summary.byStatus[p.status] = (summary.byStatus[p.status] ?? 0) + 1;
    summary.byCategory[p.category] = (summary.byCategory[p.category] ?? 0) + 1;
    if (!("Transfer" in p.kind)) continue;
    for (const t of p.kind.Transfer) {
      summary.requestedByToken[t.token] = (summary.requestedByToken[t.token] ?? 0n) + t.amount;
      if (p.status === "Executed") {
        summary.executedByToken[t.token] = (summary.executedByToken[t.token] ?? 0n) + t.amount;
      }
    }
  }

  const executed = summary.byStatus.Executed ?? 0;
  const settled = executed + (summary.byStatus.Expired ?? 0) + (summary.byStatus.Revoked ?? 0);
  summary.executionRate = settled === 0 ? 0 : executed / settled;
  return summary;
}

export interface TreasuryAnalytics {
  owners: string[];
  threshold: number;
  totalWeight: number;
  activeRecurring: number;
  proposals: ProposalSummary;
}

/** Contract maximum for `get_proposals_paged`. */
const PAGE_SIZE = 20;

/** Recipe (analytics): page through every proposal and summarize the treasury. */
export async function collectTreasuryAnalytics(client: CookbookClient): Promise<TreasuryAnalytics> {
  const proposals: Proposal[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await client.getProposalsPaged(offset, PAGE_SIZE);
    proposals.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  const [owners, threshold, totalWeight, activeRecurring] = await Promise.all([
    client.getOwners(),
    client.getThreshold(),
    client.getTotalWeight(),
    client.getActiveRecurringCount(),
  ]);
  return { owners, threshold, totalWeight, activeRecurring, proposals: summarizeProposals(proposals) };
}
