import { describe, expect, it } from "vitest";
import type { Proposal } from "../../types/accord";
import {
  handleAnalyticsRoute,
  handleGetSpendByCategory,
  handleGetSpendByOwner,
  handleGetStatsSummary,
  handleGetTreasuryBalance,
  handleGetTreasuryFlow,
  parseAndValidateAnalyticsQuery,
  QUERY_DEFAULTS,
} from "../analyticsApi";

function createMockProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 1,
    kind: "transfer",
    to: "G_RECIPIENT_ADDR",
    amount: "100.5",
    token: "XLM",
    description: "Community grant payout",
    approvals: 2,
    threshold: 2,
    status: "executed",
    deadline: "2026-06-01",
    deadlineTs: 1780272000, // 2026-06-01T00:00:00Z
    createdAt: "2026-05-15T12:00:00Z",
    proposer: "G_PROPOSER_ADDR",
    userHasApproved: true,
    approverAddresses: ["G_A1", "G_A2"],
    category: "Grant",
    ...overrides,
  };
}

describe("Analytics API - Query Parameter Parsing & Validation (#655)", () => {
  it("uses default values when parameters are omitted", () => {
    const res = parseAndValidateAnalyticsQuery(undefined);
    expect(res.success).toBe(true);
    if (!res.success) return;

    expect(res.data.limit).toBe(QUERY_DEFAULTS.LIMIT);
    expect(res.data.offset).toBe(QUERY_DEFAULTS.OFFSET);
    expect(res.data.sort).toBe(QUERY_DEFAULTS.SORT);
    expect(res.data.order).toBe(QUERY_DEFAULTS.ORDER);
    expect(res.data.category).toBeUndefined();
    expect(res.data.status).toBeUndefined();
    expect(res.data.startDate).toBeUndefined();
    expect(res.data.endDate).toBeUndefined();
  });

  it("parses valid URLSearchParams correctly", () => {
    const params = new URLSearchParams({
      limit: "50",
      offset: "10",
      sort: "amount",
      order: "asc",
      category: "Transfer",
      status: "pending",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      granularity: "month",
      timeSeries: "true",
      token: "USDC",
      owner: "G_PROPOSER",
    });

    const res = parseAndValidateAnalyticsQuery(params);
    expect(res.success).toBe(true);
    if (!res.success) return;

    expect(res.data).toEqual({
      limit: 50,
      offset: 10,
      sort: "amount",
      order: "asc",
      category: "Transfer",
      status: "pending",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      granularity: "month",
      timeSeries: true,
      token: "USDC",
      owner: "G_PROPOSER",
    });
  });

  it("rejects invalid limit (<1 or >100 or non-integer) with consistent error shape", () => {
    const invalidLimits = ["0", "-5", "101", "abc", "10.5"];
    for (const val of invalidLimits) {
      const res = parseAndValidateAnalyticsQuery({ limit: val });
      expect(res.success).toBe(false);
      if (res.success) return;

      expect(res.status).toBe(400);
      expect(res.error.error.code).toBe("VALIDATION_ERROR");
      expect(res.error.error.message).toBe("Invalid query parameters");
      expect(res.error.error.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "limit",
            code: "INVALID_LIMIT",
          }),
        ]),
      );
    }
  });

  it("rejects invalid offset (<0 or non-integer) with consistent error shape", () => {
    const invalidOffsets = ["-1", "abc", "2.5"];
    for (const val of invalidOffsets) {
      const res = parseAndValidateAnalyticsQuery({ offset: val });
      expect(res.success).toBe(false);
      if (res.success) return;

      expect(res.status).toBe(400);
      expect(res.error.error.code).toBe("VALIDATION_ERROR");
      expect(res.error.error.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "offset",
            code: "INVALID_OFFSET",
          }),
        ]),
      );
    }
  });

  it("rejects unknown sort field or order", () => {
    const resSort = parseAndValidateAnalyticsQuery({ sort: "invalid_field" });
    expect(resSort.success).toBe(false);
    if (!resSort.success) {
      expect(resSort.error.error.details?.[0].field).toBe("sort");
    }

    const resOrder = parseAndValidateAnalyticsQuery({ order: "sideways" });
    expect(resOrder.success).toBe(false);
    if (!resOrder.success) {
      expect(resOrder.error.error.details?.[0].field).toBe("order");
    }
  });

  it("rejects invalid date format or inverted date range (startDate > endDate)", () => {
    const invalidDateRes = parseAndValidateAnalyticsQuery({ startDate: "not-a-date" });
    expect(invalidDateRes.success).toBe(false);
    if (!invalidDateRes.success) {
      expect(invalidDateRes.error.error.details?.[0].code).toBe("INVALID_START_DATE");
    }

    const invertedRangeRes = parseAndValidateAnalyticsQuery({
      startDate: "2026-12-31",
      endDate: "2026-01-01",
    });
    expect(invertedRangeRes.success).toBe(false);
    if (!invertedRangeRes.success) {
      expect(invertedRangeRes.error.error.details?.[0].code).toBe("INVALID_DATE_RANGE");
    }
  });

  it("aggregates multiple validation errors in a single error response", () => {
    const res = parseAndValidateAnalyticsQuery({
      limit: "-10",
      offset: "-5",
      sort: "unsupported",
      startDate: "invalid",
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.error.details?.length).toBeGreaterThanOrEqual(4);
    }
  });
});

describe("Analytics API - GET /stats/summary (#654)", () => {
  const proposals: Proposal[] = [
    createMockProposal({
      id: 1,
      kind: "transfer",
      amount: "500",
      token: "XLM",
      status: "executed",
      deadlineTs: Math.floor(new Date("2026-03-01T00:00:00Z").getTime() / 1000),
    }),
    createMockProposal({
      id: 2,
      kind: "transfer",
      amount: "1500",
      token: "XLM",
      status: "executed",
      deadlineTs: Math.floor(new Date("2026-04-15T00:00:00Z").getTime() / 1000),
    }),
    createMockProposal({
      id: 3,
      kind: "transfer",
      amount: "250",
      token: "USDC",
      status: "executed",
      deadlineTs: Math.floor(new Date("2026-05-10T00:00:00Z").getTime() / 1000),
    }),
    createMockProposal({
      id: 4,
      kind: "transfer",
      amount: "3000",
      token: "XLM",
      status: "pending", // active, not executed
    }),
    createMockProposal({
      id: 5,
      kind: "add_owner",
      amount: "-",
      token: "XLM",
      status: "ready", // active, governance
    }),
  ];

  it("returns summary aggregation matching frontend types", () => {
    const res = handleGetStatsSummary(undefined, { proposals, ownerCount: 4 });
    expect(res.status).toBe(200);
    if (res.status !== 200) return;

    expect(res.data).toEqual({
      totalDisbursed: {
        XLM: "2000",
        USDC: "250",
      },
      totalInflows: {},
      activeProposals: 2, // pending (id 4) and ready (id 5)
      ownerCount: 4,
      largestOutflow: {
        token: "XLM",
        amount: "1500",
      },
    });
  });

  it("filters disbursements and largest outflow by date range", () => {
    // Only include April 2026
    const res = handleGetStatsSummary(
      { startDate: "2026-04-01", endDate: "2026-04-30" },
      { proposals, ownerCount: 4 },
    );
    expect(res.status).toBe(200);
    if (res.status !== 200) return;

    expect(res.data.totalDisbursed).toEqual({
      XLM: "1500",
    });
    expect(res.data.largestOutflow).toEqual({
      token: "XLM",
      amount: "1500",
    });
    // Active proposals remain the current contract active count
    expect(res.data.activeProposals).toBe(2);
    expect(res.data.ownerCount).toBe(4);
  });

  it("returns zeroed disbursements and null largestOutflow when no transfers match", () => {
    const res = handleGetStatsSummary(
      { startDate: "2025-01-01", endDate: "2025-01-31" },
      { proposals, ownerCount: 3 },
    );
    expect(res.status).toBe(200);
    if (res.status !== 200) return;

    expect(res.data.totalDisbursed).toEqual({});
    expect(res.data.largestOutflow).toBeNull();
    expect(res.data.activeProposals).toBe(2);
    expect(res.data.ownerCount).toBe(3);
  });

  it("filters by token when token parameter is specified", () => {
    const res = handleGetStatsSummary(
      { token: "USDC" },
      { proposals, ownerCount: 4 },
    );
    expect(res.status).toBe(200);
    if (res.status !== 200) return;

    expect(res.data.totalDisbursed).toEqual({
      USDC: "250",
    });
    expect(res.data.largestOutflow).toEqual({
      token: "USDC",
      amount: "250",
    });
  });

  it("returns 400 with standardized error shape on invalid query params", () => {
    const res = handleGetStatsSummary(
      { startDate: "not-a-date" },
      { proposals, ownerCount: 4 },
    );
    expect(res.status).toBe(400);
    if (res.status !== 400) return;

    expect(res.error.error.code).toBe("VALIDATION_ERROR");
    expect(res.error.error.details?.[0].field).toBe("startDate");
  });
});

describe("Analytics API - Router Dispatcher", () => {
  it("routes GET /stats/summary successfully", () => {
    const res = handleAnalyticsRoute("GET", "/stats/summary", {}, { proposals: [], ownerCount: 3 });
    expect(res.status).toBe(200);
  });

  it("rejects non-GET methods with 405 METHOD_NOT_ALLOWED", () => {
    const res = handleAnalyticsRoute("POST", "/stats/summary", {}, { proposals: [], ownerCount: 3 });
    expect(res.status).toBe(405);
    if (res.status === 405) {
      expect(res.error.error.code).toBe("METHOD_NOT_ALLOWED");
    }
  });

  it("rejects unknown routes with 404 NOT_FOUND", () => {
    const res = handleAnalyticsRoute("GET", "/stats/nonexistent", {}, { proposals: [], ownerCount: 3 });
    expect(res.status).toBe(404);
    if (res.status === 404) {
      expect(res.error.error.code).toBe("NOT_FOUND");
    }
  });
});

describe("GET /spend/by-category", () => {
  const ts = (iso: string) => Math.floor(Date.parse(iso) / 1000);
  const proposals = [
    createMockProposal({ id: 1, category: "Grant", token: "XLM", amount: "100", deadlineTs: ts("2026-03-10T00:00:00Z") }),
    createMockProposal({ id: 2, category: "Grant", token: "XLM", amount: "50", deadlineTs: ts("2026-04-10T00:00:00Z") }),
    createMockProposal({ id: 3, category: "Payroll", token: "XLM", amount: "50", deadlineTs: ts("2026-04-11T00:00:00Z") }),
    createMockProposal({ id: 4, category: "Payroll", token: "USDC", amount: "40", deadlineTs: ts("2026-04-11T00:00:00Z") }),
    createMockProposal({ id: 5, category: "Grant", amount: "999", status: "pending" }),
    createMockProposal({ id: 6, category: "Ops", amount: "999", kind: "add_owner" as Proposal["kind"] }),
  ];
  const context = { proposals, ownerCount: 3 };

  it("returns per-category totals and per-token shares from executed transfers only, largest first", () => {
    const res = handleAnalyticsRoute("GET", "/spend/by-category", undefined, context);
    expect(res.status).toBe(200);
    if (res.status !== 200) return;
    expect(res.data).toEqual([
      { category: "Grant", token: "XLM", total: "150", count: 2, share: 75 },
      { category: "Payroll", token: "XLM", total: "50", count: 1, share: 25 },
      { category: "Payroll", token: "USDC", total: "40", count: 1, share: 100 },
    ]);
  });

  it("filters by date range (endDate inclusive of its whole day)", () => {
    const res = handleGetSpendByCategory({ startDate: "2026-04-01", endDate: "2026-04-10" }, context);
    if (res.status !== 200) throw new Error("expected 200");
    expect(res.data).toEqual([
      { category: "Grant", token: "XLM", total: "50", count: 1, share: 100 },
    ]);
  });

  it("defaults an unset category to Other", () => {
    const res = handleGetSpendByCategory(undefined, {
      proposals: [createMockProposal({ id: 1, category: undefined, amount: "10" })],
      ownerCount: 1,
    });
    if (res.status !== 200) throw new Error("expected 200");
    expect(res.data).toEqual([{ category: "Other", token: "XLM", total: "10", count: 1, share: 100 }]);
  });

  it("returns an empty list when there is no executed transfer spend", () => {
    const res = handleGetSpendByCategory(undefined, { proposals: [], ownerCount: 0 });
    if (res.status !== 200) throw new Error("expected 200");
    expect(res.data).toEqual([]);
  });

  it("rejects an invalid date range with 400", () => {
    const res = handleGetSpendByCategory({ startDate: "2026-05-01", endDate: "2026-01-01" }, context);
    expect(res.status).toBe(400);
  });
});

describe("GET /spend/by-owner (#651)", () => {
  const ts = (iso: string) => Math.floor(Date.parse(iso) / 1000);
  const proposals = [
    createMockProposal({ id: 1, proposer: "G_ALICE", amount: "100", deadlineTs: ts("2026-03-10T00:00:00Z") }),
    createMockProposal({ id: 2, proposer: "G_ALICE", amount: "50.5", deadlineTs: ts("2026-04-10T00:00:00Z") }),
    createMockProposal({ id: 3, proposer: "G_BOB", amount: "20", deadlineTs: ts("2026-04-11T00:00:00Z") }),
    createMockProposal({ id: 4, proposer: "G_BOB", amount: "999", status: "pending" }),
    createMockProposal({ id: 5, proposer: "G_BOB", amount: "999", kind: "add_owner" as Proposal["kind"] }),
  ];
  const context = { proposals, ownerCount: 3, owners: ["G_ALICE", "G_BOB", "G_CAROL"] };

  it("returns per-owner totals from executed transfers only, largest first", () => {
    const res = handleAnalyticsRoute("GET", "/spend/by-owner", undefined, context);
    expect(res.status).toBe(200);
    if (res.status !== 200) return;
    expect(res.data).toEqual([
      { owner: "G_ALICE", token: "XLM", total: "150.5", count: 2 },
      { owner: "G_BOB", token: "XLM", total: "20", count: 1 },
      { owner: "G_CAROL", token: "XLM", total: "0", count: 0 },
    ]);
  });

  it("filters by date range (endDate inclusive of its whole day)", () => {
    const res = handleGetSpendByOwner({ startDate: "2026-04-01", endDate: "2026-04-10" }, context);
    if (res.status !== 200) throw new Error("expected 200");
    expect(res.data).toEqual([
      { owner: "G_ALICE", token: "XLM", total: "50.5", count: 1 },
      { owner: "G_BOB", token: "XLM", total: "0", count: 0 },
      { owner: "G_CAROL", token: "XLM", total: "0", count: 0 },
    ]);
  });

  it("includes owners with no spend as zero, even when the range excludes everything", () => {
    const res = handleGetSpendByOwner({ startDate: "2030-01-01" }, context);
    if (res.status !== 200) throw new Error("expected 200");
    expect(res.data.map((r) => [r.owner, r.total, r.count])).toEqual([
      ["G_ALICE", "0", 0],
      ["G_BOB", "0", 0],
      ["G_CAROL", "0", 0],
    ]);
  });

  it("splits an owner's spend per token", () => {
    const res = handleGetSpendByOwner(undefined, {
      proposals: [
        createMockProposal({ id: 1, proposer: "G_ALICE", amount: "10", token: "XLM" }),
        createMockProposal({ id: 2, proposer: "G_ALICE", amount: "5", token: "USDC" }),
      ],
      ownerCount: 1,
    });
    if (res.status !== 200) throw new Error("expected 200");
    expect(res.data).toHaveLength(2);
  });

  it("rejects an invalid date range with 400", () => {
    const res = handleGetSpendByOwner({ startDate: "2026-05-01", endDate: "2026-01-01" }, context);
    expect(res.status).toBe(400);
  });
});

describe("GET /treasury/balance (#652)", () => {
  const ts = (iso: string) => Math.floor(Date.parse(iso) / 1000);
  const context = {
    proposals: [],
    ownerCount: 1,
    balanceSnapshots: [
      { timestamp: ts("2026-03-03T12:00:00Z"), balances: { XLM: "300", USDC: "30" } },
      { timestamp: ts("2026-03-01T12:00:00Z"), balances: { XLM: "100", USDC: "10" } },
      { timestamp: ts("2026-03-02T12:00:00Z"), balances: { XLM: "200" } },
    ],
  };

  it("returns the latest per-token balances without a time series by default", () => {
    const res = handleAnalyticsRoute("GET", "/treasury/balance", undefined, context);
    expect(res).toEqual({ status: 200, data: { balances: { XLM: "300", USDC: "30" } } });
  });

  it("returns an ascending time series when requested", () => {
    const res = handleGetTreasuryBalance({ timeSeries: "true" }, context);
    if (res.status !== 200) throw new Error("expected 200");
    expect(res.data.timeSeries?.map((p) => p.timestamp)).toEqual([
      "2026-03-01T12:00:00.000Z",
      "2026-03-02T12:00:00.000Z",
      "2026-03-03T12:00:00.000Z",
    ]);
    expect(res.data.timeSeries?.[1].values).toEqual({ XLM: "200" });
  });

  it("applies the date range to the series and to the current balance", () => {
    const res = handleGetTreasuryBalance(
      { timeSeries: "true", startDate: "2026-03-01", endDate: "2026-03-02" },
      context,
    );
    if (res.status !== 200) throw new Error("expected 200");
    expect(res.data.balances).toEqual({ XLM: "200" });
    expect(res.data.timeSeries).toHaveLength(2);
  });

  it("filters by token", () => {
    const res = handleGetTreasuryBalance({ token: "USDC", timeSeries: "true" }, context);
    if (res.status !== 200) throw new Error("expected 200");
    expect(res.data.balances).toEqual({ USDC: "30" });
    expect(res.data.timeSeries?.map((p) => p.values)).toEqual([{ USDC: "10" }, {}, { USDC: "30" }]);
  });

  it("returns empty balances when there are no snapshots", () => {
    expect(handleGetTreasuryBalance(undefined, { proposals: [], ownerCount: 0 })).toEqual({
      status: 200,
      data: { balances: {} },
    });
  });
});

describe("GET /treasury/flow (#653)", () => {
  const ts = (iso: string) => Math.floor(Date.parse(iso) / 1000);
  const context = {
    proposals: [
      createMockProposal({ id: 1, amount: "40", deadlineTs: ts("2026-03-02T10:00:00Z") }),
      createMockProposal({ id: 2, amount: "10", deadlineTs: ts("2026-03-04T10:00:00Z") }),
      createMockProposal({ id: 3, amount: "5", status: "pending", deadlineTs: ts("2026-03-03T10:00:00Z") }),
    ],
    ownerCount: 1,
    deposits: [
      { timestamp: ts("2026-03-02T09:00:00Z"), token: "XLM", amount: "100" },
      { timestamp: ts("2026-03-02T11:00:00Z"), token: "XLM", amount: "25" },
    ],
  };

  it("returns inflow and outflow buckets, zero-filling empty days", () => {
    const res = handleAnalyticsRoute("GET", "/treasury/flow", { granularity: "day" }, context);
    if (res.status !== 200) throw new Error("expected 200");
    expect(res.data).toEqual([
      { timestamp: "2026-03-02T00:00:00.000Z", token: "XLM", inflow: "125", outflow: "40" },
      { timestamp: "2026-03-03T00:00:00.000Z", token: "XLM", inflow: "0", outflow: "0" },
      { timestamp: "2026-03-04T00:00:00.000Z", token: "XLM", inflow: "0", outflow: "10" },
    ]);
  });

  it("defaults to daily granularity", () => {
    const a = handleGetTreasuryFlow(undefined, context);
    const b = handleGetTreasuryFlow({ granularity: "day" }, context);
    expect(a).toEqual(b);
  });

  it("zero-fills to the requested date range, not just the data extent", () => {
    const res = handleGetTreasuryFlow({ startDate: "2026-03-01", endDate: "2026-03-05" }, context);
    if (res.status !== 200) throw new Error("expected 200");
    expect(res.data.map((b) => b.timestamp.slice(0, 10))).toEqual([
      "2026-03-01", "2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05",
    ]);
    expect(res.data[0]).toMatchObject({ inflow: "0", outflow: "0" });
  });

  it("buckets weekly on Mondays", () => {
    // 2026-03-02 is a Monday; 2026-03-15 is a Sunday; 2026-03-16 starts a new week.
    const res = handleGetTreasuryFlow(
      { granularity: "week", startDate: "2026-03-01", endDate: "2026-03-20" },
      {
        proposals: [
          createMockProposal({ id: 1, amount: "1", deadlineTs: ts("2026-03-15T23:00:00Z") }),
          createMockProposal({ id: 2, amount: "2", deadlineTs: ts("2026-03-16T00:00:00Z") }),
        ],
        ownerCount: 1,
      },
    );
    if (res.status !== 200) throw new Error("expected 200");
    expect(res.data.map((b) => [b.timestamp.slice(0, 10), b.outflow])).toEqual([
      ["2026-02-23", "0"],
      ["2026-03-02", "0"],
      ["2026-03-09", "1"],
      ["2026-03-16", "2"],
    ]);
  });

  it("buckets monthly, including empty months", () => {
    const res = handleGetTreasuryFlow(
      { granularity: "month", startDate: "2026-01-15", endDate: "2026-03-31" },
      context,
    );
    if (res.status !== 200) throw new Error("expected 200");
    expect(res.data.map((b) => [b.timestamp.slice(0, 10), b.inflow, b.outflow])).toEqual([
      ["2026-01-01", "0", "0"],
      ["2026-02-01", "0", "0"],
      ["2026-03-01", "125", "50"],
    ]);
  });

  it("zero-fills each token separately", () => {
    const res = handleGetTreasuryFlow(undefined, {
      proposals: [],
      ownerCount: 1,
      deposits: [
        { timestamp: ts("2026-03-01T00:00:00Z"), token: "XLM", amount: "1" },
        { timestamp: ts("2026-03-02T00:00:00Z"), token: "USDC", amount: "2" },
      ],
    });
    if (res.status !== 200) throw new Error("expected 200");
    expect(res.data).toHaveLength(4);
  });

  it("returns an empty list with no activity and no range", () => {
    expect(handleGetTreasuryFlow(undefined, { proposals: [], ownerCount: 0 })).toEqual({
      status: 200,
      data: [],
    });
  });

  it("rejects an invalid granularity with 400", () => {
    expect(handleGetTreasuryFlow({ granularity: "hour" }, context).status).toBe(400);
  });
});
