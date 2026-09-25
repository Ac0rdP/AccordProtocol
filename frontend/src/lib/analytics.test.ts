import { describe, expect, test } from "vitest";
import type { Proposal } from "../types/accord";
import {
  buildExportFilename,
  buildSpendCsv,
  buildTreasuryCsv,
  computeSpendByCategory,
  computeSpendByOwner,
  computeTreasuryFlow,
  DEFAULT_ANALYTICS_FILTERS,
  enrichWithShares,
  filterExecutedTransfers,
  formatShare,
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

describe("buildExportFilename", () => {
  test("uses 'all-time' when no date range is set", () => {
    expect(buildExportFilename("spend", DEFAULT_ANALYTICS_FILTERS)).toBe(
      "accord-analytics-spend-all-time",
    );
  });

  test("includes the date range when set", () => {
    const filename = buildExportFilename("treasury", {
      ...DEFAULT_ANALYTICS_FILTERS,
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    expect(filename).toBe("accord-analytics-treasury-2026-01-01_to_2026-01-31");
  });

  test("falls back to 'start'/'now' for a one-sided range", () => {
    expect(
      buildExportFilename("spend", {
        ...DEFAULT_ANALYTICS_FILTERS,
        endDate: "2026-01-31",
      }),
    ).toBe("accord-analytics-spend-start_to_2026-01-31");
  });
});

describe("buildSpendCsv", () => {
  test("produces a CSV with headers and one row per category", () => {
    const csv = buildSpendCsv([
      { category: "Grant", total: 150, count: 2 },
      { category: "Payroll", total: 500, count: 1 },
    ]);

    expect(csv).toBe(
      'Category,Total,Transaction Count\n"Grant","150.00",2\n"Payroll","500.00",1',
    );
  });
});

describe("buildTreasuryCsv", () => {
  test("produces a CSV with headers and one row per period", () => {
    const csv = buildTreasuryCsv([
      { period: "2026-01", outflow: 150, cumulative: 150 },
      { period: "2026-02", outflow: 25, cumulative: 175 },
    ]);

    expect(csv).toBe(
      'Period,Outflow,Cumulative Outflow\n"2026-01","150.00","150.00"\n"2026-02","25.00","175.00"',
    );
  });
});

describe("enrichWithShares", () => {
  test("computes percentage share for each category", () => {
    const rows = [
      { category: "Grant", total: 600, count: 3 },
      { category: "Payroll", total: 300, count: 2 },
      { category: "Ops", total: 100, count: 1 },
    ];
    const result = enrichWithShares(rows);
    expect(result[0].share).toBeCloseTo(60);
    expect(result[1].share).toBeCloseTo(30);
    expect(result[2].share).toBeCloseTo(10);
  });

  test("returns 0 share for all rows when grand total is 0", () => {
    const rows = [{ category: "Grant", total: 0, count: 1 }];
    const result = enrichWithShares(rows);
    expect(result[0].share).toBe(0);
  });

  test("returns an empty array for empty input", () => {
    expect(enrichWithShares([])).toEqual([]);
  });
});

describe("formatShare", () => {
  test("formats to one decimal place with % suffix", () => {
    expect(formatShare(60)).toBe("60.0%");
    expect(formatShare(33.333)).toBe("33.3%");
    expect(formatShare(0)).toBe("0.0%");
    expect(formatShare(100)).toBe("100.0%");
  });
});

describe("computeSpendByOwner", () => {
  test("sums amounts and counts per owner address, sorted by total descending", () => {
    const proposals = [
      makeProposal({ id: 1, proposer: "GPROPOSER11111111111111111111111111111111111111111111111", amount: "100" }),
      makeProposal({ id: 2, proposer: "GPROPOSER11111111111111111111111111111111111111111111111", amount: "200" }),
      makeProposal({ id: 3, proposer: "GPROPOSER22222222222222222222222222222222222222222222222", amount: "50" }),
    ];

    const result = computeSpendByOwner(proposals);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      owner: "GPROPOSER11111111111111111111111111111111111111111111111",
      shortOwner: "GPROPO...1111",
      total: 300,
      count: 2,
    });
    expect(result[1]).toEqual({
      owner: "GPROPOSER22222222222222222222222222222222222222222222222",
      shortOwner: "GPROPO...2222",
      total: 50,
      count: 1,
    });
  });

  test("returns empty array for no proposals", () => {
    expect(computeSpendByOwner([])).toEqual([]);
  });
});

// TODO: Add tests for the analytics HTTP API covering both successful responses and rejected input.
