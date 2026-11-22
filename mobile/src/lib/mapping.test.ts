import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatDeadline, shortenAddress, stroopsToDisplay } from "./format";
import { mapApprovalState, mapKind, mapProposal, mapStatus } from "./mapping";

describe("formatting", () => {
  it("converts stroops with full precision", () => {
    assert.equal(stroopsToDisplay(10_000_000n), "1");
    assert.equal(stroopsToDisplay(1_250_000n), "0.125");
    assert.equal(stroopsToDisplay(0n), "0");
  });

  it("shortens addresses and formats deadlines deterministically", () => {
    assert.equal(shortenAddress("GABCDEFGHIJKLMNOPQRSTUVWXYZ234567"), "GABCDE...4567");
    assert.equal(shortenAddress("short"), "short");
    assert.equal(formatDeadline(0), "No deadline");
    assert.equal(formatDeadline(1_700_000_000), "2023-11-14 22:13 UTC");
  });
});

describe("mapping contract values", () => {
  it("maps every Soroban status variant and unknown fallbacks", () => {
    assert.equal(mapStatus("Ready"), "ready");
    assert.equal(mapStatus({ Executed: null }), "executed");
    assert.equal(mapStatus({ Revoked: [] }), "revoked");
    assert.equal(mapStatus(undefined), "pending");
  });

  it("maps struct-based transfers and sums multiple recipients", () => {
    const result = mapKind({
      Transfer: [
        { to: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", token: "TOKEN", amount: 10_000_000n },
        { to: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", token: "TOKEN", amount: 5_000_000n },
      ],
    });
    assert.equal(result.kind, "transfer");
    assert.equal(result.amount, "1.5");
    assert.equal(result.to, "2 recipients");
  });

  it("supports the legacy flat transfer tuple", () => {
    const result = mapKind({ Transfer: ["recipient-address", 2_500_000n, "token-address"] });
    assert.equal(result.amount, "0.25");
    assert.equal(result.to, "recipi...ress");
  });

  it("maps ownership and role changes", () => {
    assert.equal(mapKind({ AddOwner: ["GNEW", 2] }).kind, "add_owner");
    assert.equal(mapKind({ ChangeThreshold: 3 }).to, "3 approvals");
    assert.equal(mapKind({ GrantRole: ["GTARGET", "Approver"] }).token, "Approver");
  });

  it("maps a full proposal record", () => {
    const proposal = mapProposal(
      {
        id: 12n,
        description: "Pay contributor",
        deadline: 1_700_000_000n,
        approvals: 1,
        approval_weight: 2,
        quorum_weight: 3,
        status: "Pending",
        proposer: "GPROPOSER",
        kind: { Transfer: [{ to: "GBOB", token: "GUSDC", amount: 1_000_000n }] },
      },
      3,
    );
    assert.deepEqual(
      {
        id: proposal.id,
        description: proposal.description,
        status: proposal.status,
        approvals: proposal.approvals,
        approvalWeight: proposal.approvalWeight,
        quorumWeight: proposal.quorumWeight,
        threshold: proposal.threshold,
        deadlineTs: proposal.deadlineTs,
        userHasApproved: proposal.userHasApproved,
      },
      {
        id: 12,
        description: "Pay contributor",
        status: "pending",
        approvals: 1,
        approvalWeight: 2,
        quorumWeight: 3,
        threshold: 3,
        deadlineTs: 1_700_000_000,
        userHasApproved: false,
      },
    );
    assert.equal(proposal.amount, "0.1");
  });

  it("detects the connected owner's prior approval", () => {
    const proposal = mapProposal(
      { id: 1n, approver_addresses: ["GME", "GOTHER"], status: "Ready" },
      2,
      "GME",
    );
    assert.equal(proposal.userHasApproved, true);
  });

  it("maps approval progress from named fields and tuples", () => {
    assert.deepEqual(
      mapApprovalState({ approval_weight: 4n, quorum_weight: 6n, total_weight: 10n }),
      { approvalWeight: 4, quorumWeight: 6, totalWeight: 10 },
    );
    assert.deepEqual(mapApprovalState([2n, 3n, 5n], 3), {
      approvalWeight: 2,
      quorumWeight: 3,
      totalWeight: 5,
    });
  });
});
