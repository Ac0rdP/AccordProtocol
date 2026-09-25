import { describe, expect, it } from "vitest";
import type { Proposal } from "../../types/accord";
import {
  createErrorResponse,
  createValidationError,
  handleAnalyticsRoute,
  handleGetStatsSummary,
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
