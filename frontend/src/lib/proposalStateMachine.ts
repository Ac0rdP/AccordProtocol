import type { ProposalKind, ProposalStatus } from "../types/accord";

/** Every proposal kind the UI must cover with transition tests. */
export const ALL_PROPOSAL_KINDS: readonly ProposalKind[] = [
  "transfer",
  "add_owner",
  "remove_owner",
  "change_threshold",
  "set_spending_limit",
  "change_owner_weight",
  "grant_role",
  "revoke_role",
  "recurring",
] as const;

/** Statuses that may never be left once entered. */
export const TERMINAL_STATUSES: readonly ProposalStatus[] = [
  "executed",
  "expired",
  "revoked",
] as const;

export type ProposalTransitionEvent =
  | { type: "approve"; approvalWeight: number; quorumWeight: number }
  | { type: "revoke_approval"; approvalWeight: number; quorumWeight: number }
  | { type: "execute" }
  | { type: "expire"; nowTs: number; deadlineTs: number }
  | { type: "revoke_proposal" };

export type TransitionResult =
  | { ok: true; status: ProposalStatus }
  | { ok: false; status: ProposalStatus; reason: string };

/**
 * Pure status transition helper shared by UI optimistic updates and tests.
 * Kind-agnostic: every ProposalKind shares the same Pending → Ready →
 * Executed / Expired lifecycle; kind-specific authorization lives elsewhere.
 */
export function applyProposalTransition(
  kind: ProposalKind,
  current: ProposalStatus,
  event: ProposalTransitionEvent,
): TransitionResult {
  // Kind is accepted so callers (and the coverage guard) stay kind-aware.
  void kind;

  if (TERMINAL_STATUSES.includes(current)) {
    return {
      ok: false,
      status: current,
      reason: `Terminal status "${current}" cannot transition`,
    };
  }

  switch (event.type) {
    case "approve": {
      if (current !== "pending" && current !== "ready") {
        return {
          ok: false,
          status: current,
          reason: `Cannot approve from "${current}"`,
        };
      }
      const next: ProposalStatus =
        event.approvalWeight >= event.quorumWeight ? "ready" : "pending";
      return { ok: true, status: next };
    }

    case "revoke_approval": {
      if (current !== "pending" && current !== "ready") {
        return {
          ok: false,
          status: current,
          reason: `Cannot revoke approval from "${current}"`,
        };
      }
      const next: ProposalStatus =
        event.approvalWeight >= event.quorumWeight ? "ready" : "pending";
      return { ok: true, status: next };
    }

    case "execute": {
      if (current !== "ready") {
        return {
          ok: false,
          status: current,
          reason: `Cannot execute from "${current}" (must be ready)`,
        };
      }
      return { ok: true, status: "executed" };
    }

    case "expire": {
      if (current !== "pending" && current !== "ready") {
        return {
          ok: false,
          status: current,
          reason: `Cannot expire from "${current}"`,
        };
      }
      if (event.nowTs < event.deadlineTs) {
        return {
          ok: false,
          status: current,
          reason: "Deadline has not passed",
        };
      }
      return { ok: true, status: "expired" };
    }

    case "revoke_proposal": {
      if (current !== "pending" && current !== "ready") {
        return {
          ok: false,
          status: current,
          reason: `Cannot revoke proposal from "${current}"`,
        };
      }
      return { ok: true, status: "revoked" };
    }

    default: {
      const _exhaustive: never = event;
      return {
        ok: false,
        status: current,
        reason: `Unknown event ${JSON.stringify(_exhaustive)}`,
      };
    }
  }
}

/**
 * Returns true when approving with the given weight lands exactly on quorum
 * (the Ready boundary). Used by tests to pin the exact-quorum case.
 */
export function reachesExactQuorum(
  approvalWeight: number,
  quorumWeight: number,
): boolean {
  return approvalWeight === quorumWeight;
}
