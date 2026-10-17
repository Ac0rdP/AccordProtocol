import { describe, expect, it } from "vitest";
import { aggregateOwnerActivity, addressesMatch } from "../ownerActivity";
import type { Proposal } from "../../types/accord";

describe("ownerActivity aggregation", () => {
  const ownerA = "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4IQDNC";
  const ownerB = "GBPLX2P3VWYKPQ7L5RI5OGXQ6T4G7QZMJ3HPQD7FZX5KJ3H2Z4YK5ABC";
  const ownerC = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAA";

  const sampleProposals: Proposal[] = [
    {
      id: 1,
      kind: "transfer",
      to: "GDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      amount: "100",
      token: "XLM",
      proposer: ownerA,
      approvers: 2,
      approvals: 2,
      threshold: 2,
      status: "executed",
      userHasApproved: false,
      approverAddresses: [ownerA, ownerB],
      createdAt: "2026-01-01",
      deadline: "2026-02-01",
      deadlineTs: 1770000000000,
    },
    {
      id: 2,
      kind: "transfer",
      to: "GDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      amount: "200",
      token: "XLM",
      proposer: ownerB,
      approvers: 1,
      approvals: 1,
      threshold: 2,
      status: "pending",
      userHasApproved: false,
      approverAddresses: [ownerB],
      createdAt: "2026-01-02",
      deadline: "2026-02-01",
      deadlineTs: 1770000000000,
    },
    {
      id: 3,
      kind: "add_owner",
      to: ownerC,
      amount: "0",
      token: "XLM",
      proposer: ownerA,
      approvers: 1,
      approvals: 1,
      threshold: 2,
      status: "pending",
      userHasApproved: false,
      approverAddresses: [ownerA],
      createdAt: "2026-01-03",
      deadline: "2026-02-01",
      deadlineTs: 1770000000000,
    },
  ];

  it("accurately aggregates proposals created by and approved by ownerA", () => {
    const summary = aggregateOwnerActivity(ownerA, sampleProposals);

    expect(summary.createdCount).toBe(2);
    expect(summary.createdProposals.map((p) => p.id)).toEqual([1, 3]);

    expect(summary.approvedCount).toBe(2);
    expect(summary.approvedProposals.map((p) => p.id)).toEqual([1, 3]);

    expect(summary.totalCount).toBe(4);
    expect(summary.hasActivity).toBe(true);
  });

  it("accurately aggregates proposals for ownerB", () => {
    const summary = aggregateOwnerActivity(ownerB, sampleProposals);

    expect(summary.createdCount).toBe(1);
    expect(summary.createdProposals.map((p) => p.id)).toEqual([2]);

    expect(summary.approvedCount).toBe(2);
    expect(summary.approvedProposals.map((p) => p.id)).toEqual([1, 2]);

    expect(summary.totalCount).toBe(3);
    expect(summary.hasActivity).toBe(true);
  });

  it("handles owners with no activity with clear zero counts", () => {
    const summary = aggregateOwnerActivity(ownerC, sampleProposals);

    expect(summary.createdCount).toBe(0);
    expect(summary.approvedCount).toBe(0);
    expect(summary.totalCount).toBe(0);
    expect(summary.hasActivity).toBe(false);
    expect(summary.createdProposals).toEqual([]);
    expect(summary.approvedProposals).toEqual([]);
  });

  it("matches addresses across full and shortened formats", () => {
    expect(addressesMatch(ownerA, ownerA)).toBe(true);
    expect(addressesMatch(ownerA, "GDHU6W…QDNC")).toBe(true);
    expect(addressesMatch("GDHU6W...QDNC", ownerA)).toBe(true);
    expect(addressesMatch(ownerA, ownerB)).toBe(false);
  });
});
