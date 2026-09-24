import { describe, expect, test } from "vitest";
import type { Proposal } from "../types/accord";
import {
  computeSpendByCategory,
  computeTreasuryFlow,
  DEFAULT_ANALYTICS_FILTERS,
  filterExecutedTransfers,
} from "./analytics";

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 1,
    kind: "transfer",
    to: "GRECIPIENT",
    amount: "100",
    token: "XLM",
    description: "Test proposal",
    approvals: 2,
    threshold: 2,
    status: "executed",
    deadline: "Jan 15, 2026",
    deadlineTs: 1768435200, // 2026-01-15T00:00:00Z
    createdAt: "proposal #1",
    proposer: "GPROPOSER1",
    userHasApproved: true,
    approverAddresses: ["GA1", "GA2"],
    category: "Grant",
    ...overrides,
  };
}

describe("filterExecutedTransfers", () => {
  test("keeps only executed transfer proposals", () => {
    const proposals = [
      makeProposal({ id: 1, status: "executed", kind: "transfer" }),
      makeProposal({ id: 2, status: "pending", kind: "transfer" }),
      makeProposal({
        id: 3,
        status: "executed",
        kind: "add_owner",
        amount: "-",
      }),
    ];

    const result = filterExecutedTransfers(
      proposals,
      DEFAULT_ANALYTICS_FILTERS,
    );
    expect(result.map((p) => p.id)).toEqual([1]);
  });
});

describe("computeSpendByCategory", () => {
  test("sums amounts and counts per category, sorted by total descending", () => {
    const proposals = [
      makeProposal({ id: 1, category: "Grant", amount: "100" }),
      makeProposal({ id: 2, category: "Grant", amount: "50" }),
      makeProposal({ id: 3, category: "Payroll", amount: "500" }),
    ];

    expect(computeSpendByCategory(proposals)).toEqual([
      { category: "Payroll", total: 500, count: 1 },
      { category: "Grant", total: 150, count: 2 },
    ]);
  });

  test("buckets undefined category as 'Other' and ignores unparseable amounts", () => {
    const proposals = [
      makeProposal({ id: 1, category: undefined, amount: "25" }),
      makeProposal({ id: 2, category: undefined, amount: "-" }),
    ];

    expect(computeSpendByCategory(proposals)).toEqual([
      { category: "Other", total: 25, count: 2 },
    ]);
  });

  test("returns an empty array for no proposals", () => {
    expect(computeSpendByCategory([])).toEqual([]);
  });
});

describe("computeTreasuryFlow", () => {
  test("groups by UTC year-month and accumulates a running total", () => {
    const jan = Math.floor(new Date("2026-01-10T00:00:00Z").getTime() / 1000);
    const janLater = Math.floor(
      new Date("2026-01-20T00:00:00Z").getTime() / 1000,
    );
    const feb = Math.floor(new Date("2026-02-05T00:00:00Z").getTime() / 1000);

    const proposals = [
      makeProposal({ id: 1, deadlineTs: jan, amount: "100" }),
      makeProposal({ id: 2, deadlineTs: janLater, amount: "50" }),
      makeProposal({ id: 3, deadlineTs: feb, amount: "25" }),
    ];

    expect(computeTreasuryFlow(proposals)).toEqual([
      { period: "2026-01", outflow: 150, cumulative: 150 },
      { period: "2026-02", outflow: 25, cumulative: 175 },
    ]);
  });

  test("returns an empty array for no proposals", () => {
    expect(computeTreasuryFlow([])).toEqual([]);
  });
});
