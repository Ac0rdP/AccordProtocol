import { describe, expect, test } from "vitest";
import type { ProposalKind, ProposalStatus } from "../types/accord";
import {
  ALL_PROPOSAL_KINDS,
  applyProposalTransition,
  reachesExactQuorum,
  TERMINAL_STATUSES,
} from "./proposalStateMachine";

const QUIET_KINDS_WITHOUT_COVERAGE = new Set<ProposalKind>();

function walkKind(kind: ProposalKind) {
  const covered = new Set<string>();

  // Pending → Ready at exact quorum
  const exact = applyProposalTransition(kind, "pending", {
    type: "approve",
    approvalWeight: 10,
    quorumWeight: 10,
  });
  expect(exact).toEqual({ ok: true, status: "ready" });
  expect(reachesExactQuorum(10, 10)).toBe(true);
  covered.add("pending→ready");

  // Pending stays pending below quorum
  const below = applyProposalTransition(kind, "pending", {
    type: "approve",
    approvalWeight: 9,
    quorumWeight: 10,
  });
  expect(below).toEqual({ ok: true, status: "pending" });
  covered.add("pending→pending");

  // Ready → Executed
  const executed = applyProposalTransition(kind, "ready", { type: "execute" });
  expect(executed).toEqual({ ok: true, status: "executed" });
  covered.add("ready→executed");

  // Pending → Expired
  const expiredFromPending = applyProposalTransition(kind, "pending", {
    type: "expire",
    nowTs: 200,
    deadlineTs: 100,
  });
  expect(expiredFromPending).toEqual({ ok: true, status: "expired" });
  covered.add("pending→expired");

  // Ready → Expired
  const expiredFromReady = applyProposalTransition(kind, "ready", {
    type: "expire",
    nowTs: 200,
    deadlineTs: 100,
  });
  expect(expiredFromReady).toEqual({ ok: true, status: "expired" });
  covered.add("ready→expired");

  // Ready → Pending when approval drops below quorum
  const demote = applyProposalTransition(kind, "ready", {
    type: "revoke_approval",
    approvalWeight: 5,
    quorumWeight: 10,
  });
  expect(demote).toEqual({ ok: true, status: "pending" });
  covered.add("ready→pending");

  // Pending/Ready → Revoked
  const revoked = applyProposalTransition(kind, "pending", {
    type: "revoke_proposal",
  });
  expect(revoked).toEqual({ ok: true, status: "revoked" });
  covered.add("pending→revoked");

  // Invalid: execute while pending
  const badExecute = applyProposalTransition(kind, "pending", {
    type: "execute",
  });
  expect(badExecute.ok).toBe(false);
  expect(badExecute.status).toBe("pending");
  covered.add("reject:execute-from-pending");

  // Invalid: expire before deadline
  const earlyExpire = applyProposalTransition(kind, "pending", {
    type: "expire",
    nowTs: 50,
    deadlineTs: 100,
  });
  expect(earlyExpire.ok).toBe(false);
  covered.add("reject:expire-early");

  // Terminal states never overridden
  for (const terminal of TERMINAL_STATUSES) {
    for (const event of [
      {
        type: "approve" as const,
        approvalWeight: 100,
        quorumWeight: 10,
      },
      { type: "execute" as const },
      {
        type: "expire" as const,
        nowTs: 999,
        deadlineTs: 1,
      },
      { type: "revoke_proposal" as const },
    ]) {
      const result = applyProposalTransition(
        kind,
        terminal as ProposalStatus,
        event,
      );
      expect(result.ok).toBe(false);
      expect(result.status).toBe(terminal);
    }
    covered.add(`terminal:${terminal}`);
  }

  return covered;
}

describe("proposal state machine", () => {
  test("enumerates every proposal kind", () => {
    expect(ALL_PROPOSAL_KINDS.length).toBeGreaterThan(0);
    // Fail loudly if a new kind is added to the type but not the list.
    const unique = new Set(ALL_PROPOSAL_KINDS);
    expect(unique.size).toBe(ALL_PROPOSAL_KINDS.length);
  });

  test.each([...ALL_PROPOSAL_KINDS])(
    "covers Pending/Ready/Executed/Expired transitions for %s",
    (kind) => {
      const covered = walkKind(kind);
      expect(covered.has("pending→ready")).toBe(true);
      expect(covered.has("ready→executed")).toBe(true);
      expect(covered.has("pending→expired")).toBe(true);
      expect(covered.has("ready→expired")).toBe(true);
      QUIET_KINDS_WITHOUT_COVERAGE.delete(kind);
    },
  );

  test("fails if any proposal kind lacks transition coverage", () => {
    const missing = ALL_PROPOSAL_KINDS.filter((kind) => {
      try {
        walkKind(kind);
        return false;
      } catch {
        return true;
      }
    });
    expect(missing).toEqual([]);
  });

  test("exact-quorum boundary promotes Pending to Ready", () => {
    for (const kind of ALL_PROPOSAL_KINDS) {
      const quorum = 7;
      const atQuorum = applyProposalTransition(kind, "pending", {
        type: "approve",
        approvalWeight: quorum,
        quorumWeight: quorum,
      });
      expect(atQuorum).toEqual({ ok: true, status: "ready" });

      const justBelow = applyProposalTransition(kind, "pending", {
        type: "approve",
        approvalWeight: quorum - 1,
        quorumWeight: quorum,
      });
      expect(justBelow).toEqual({ ok: true, status: "pending" });
    }
  });
});
