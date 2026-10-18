import type {
  AnalyticsAmount,
  BalanceSnapshot,
  TreasuryDeposit,
  AnalyticsApiErrorDetail,
  AnalyticsApiErrorResponse,
  AnalyticsGranularity,
  CategorySpendBucket,
  OwnerSpendBucket,
  ParsedAnalyticsQuery,
  Proposal,
  ProposalCategory,
  ProposalStatus,
  TreasuryBalance,
  TreasuryFlowBucket,
  TreasurySummary,
} from "../types/accord";

export const ALLOWED_SORT_FIELDS = ["deadline", "amount", "createdAt"] as const;
export const ALLOWED_SORT_ORDERS = ["asc", "desc"] as const;
export const ALLOWED_GRANULARITIES = ["day", "week", "month"] as const;
export const ALLOWED_CATEGORIES: ProposalCategory[] = [
  "Transfer",
  "Payroll",
  "Grant",
  "Ops",
  "Other",
];
export const ALLOWED_STATUSES: ProposalStatus[] = [
  "pending",
  "ready",
  "executed",
  "expired",
  "revoked",
];

export const QUERY_DEFAULTS = {
  LIMIT: 20,
  MIN_LIMIT: 1,
  MAX_LIMIT: 100,
  OFFSET: 0,
  MIN_OFFSET: 0,
  SORT: "createdAt" as const,
  ORDER: "desc" as const,
} as const;

/**
 * Creates a standardized API error response.
 */
export function createErrorResponse(
  code: string,
  message: string,
  details?: AnalyticsApiErrorDetail[],
): AnalyticsApiErrorResponse {
  const res: AnalyticsApiErrorResponse = {
    error: {
      code,
      message,
    },
  };
  if (details && details.length > 0) {
    res.error.details = details;
  }
  return res;
}

/**
 * Creates a standardized 400 validation error response.
 */
export function createValidationError(
  message: string,
  details?: AnalyticsApiErrorDetail[],
): AnalyticsApiErrorResponse {
  return createErrorResponse("VALIDATION_ERROR", message, details);
}

export type QueryValidationResult =
  | { success: true; data: ParsedAnalyticsQuery }
  | { success: false; status: 400; error: AnalyticsApiErrorResponse };

function isValidIsoDate(value: string): boolean {
  if (!value) return false;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed);
}

/**
 * Standardized query-parameter parsing and validation across all analytics endpoints.
 *
 * Rules:
 * - limit: integer between 1 and 100 (default 20)
 * - offset: non-negative integer (default 0)
 * - sort: "deadline" | "amount" | "createdAt" (default "createdAt")
 * - order: "asc" | "desc" (default "desc")
 * - category: "all" or valid ProposalCategory
 * - status: "all" or valid ProposalStatus
 * - startDate / endDate: valid ISO date/date-time strings; startDate <= endDate
 * - granularity: "day" | "week" | "month"
 * - timeSeries: boolean ("true", "false", or boolean)
 */
export function parseAndValidateAnalyticsQuery(
  raw: URLSearchParams | Record<string, unknown> | undefined,
): QueryValidationResult {
  const getParam = (key: string): string | undefined => {
    if (!raw) return undefined;
    if (raw instanceof URLSearchParams) {
      const val = raw.get(key);
      return val !== null && val !== "" ? val : undefined;
    }
    const val = raw[key];
    if (val === undefined || val === null || val === "") return undefined;
    return String(val);
  };

  const details: AnalyticsApiErrorDetail[] = [];

  // Parse limit
  let limit: number = QUERY_DEFAULTS.LIMIT;
  const rawLimit = getParam("limit");
  if (rawLimit !== undefined) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < QUERY_DEFAULTS.MIN_LIMIT || parsed > QUERY_DEFAULTS.MAX_LIMIT) {
      details.push({
        field: "limit",
        message: `Limit must be an integer between ${QUERY_DEFAULTS.MIN_LIMIT} and ${QUERY_DEFAULTS.MAX_LIMIT}`,
        code: "INVALID_LIMIT",
      });
    } else {
      limit = parsed;
    }
  }

  // Parse offset
  let offset: number = QUERY_DEFAULTS.OFFSET;
  const rawOffset = getParam("offset");
  if (rawOffset !== undefined) {
    const parsed = Number(rawOffset);
    if (!Number.isInteger(parsed) || parsed < QUERY_DEFAULTS.MIN_OFFSET) {
      details.push({
        field: "offset",
        message: `Offset must be a non-negative integer`,
        code: "INVALID_OFFSET",
      });
    } else {
      offset = parsed;
    }
  }

  // Parse sort
  let sort: "deadline" | "amount" | "createdAt" = QUERY_DEFAULTS.SORT;
  const rawSort = getParam("sort");
  if (rawSort !== undefined) {
    if (!ALLOWED_SORT_FIELDS.includes(rawSort as (typeof ALLOWED_SORT_FIELDS)[number])) {
      details.push({
        field: "sort",
        message: `Sort must be one of: ${ALLOWED_SORT_FIELDS.join(", ")}`,
        code: "INVALID_SORT",
      });
    } else {
      sort = rawSort as (typeof ALLOWED_SORT_FIELDS)[number];
    }
  }

  // Parse order
  let order: "asc" | "desc" = QUERY_DEFAULTS.ORDER;
  const rawOrder = getParam("order");
  if (rawOrder !== undefined) {
    const lower = rawOrder.toLowerCase();
    if (!ALLOWED_SORT_ORDERS.includes(lower as (typeof ALLOWED_SORT_ORDERS)[number])) {
      details.push({
        field: "order",
        message: `Order must be one of: ${ALLOWED_SORT_ORDERS.join(", ")}`,
        code: "INVALID_ORDER",
      });
    } else {
      order = lower as (typeof ALLOWED_SORT_ORDERS)[number];
    }
  }

  // Parse category
  let category: ProposalCategory | undefined;
  const rawCategory = getParam("category");
  if (rawCategory !== undefined && rawCategory !== "all") {
    if (!ALLOWED_CATEGORIES.includes(rawCategory as ProposalCategory)) {
      details.push({
        field: "category",
        message: `Category must be 'all' or one of: ${ALLOWED_CATEGORIES.join(", ")}`,
        code: "INVALID_CATEGORY",
      });
    } else {
      category = rawCategory as ProposalCategory;
    }
  }

  // Parse status
  let status: ProposalStatus | undefined;
  const rawStatus = getParam("status");
  if (rawStatus !== undefined && rawStatus !== "all") {
    if (!ALLOWED_STATUSES.includes(rawStatus as ProposalStatus)) {
      details.push({
        field: "status",
        message: `Status must be 'all' or one of: ${ALLOWED_STATUSES.join(", ")}`,
        code: "INVALID_STATUS",
      });
    } else {
      status = rawStatus as ProposalStatus;
    }
  }

  // Parse owner
  const rawOwner = getParam("owner");
  const owner = rawOwner ? rawOwner.trim() : undefined;

  // Parse token
  const rawToken = getParam("token");
  const token = rawToken ? rawToken.trim() : undefined;

  // Parse startDate & endDate
  const rawStartDate = getParam("startDate");
  let startDate: string | undefined;
  if (rawStartDate !== undefined) {
    if (!isValidIsoDate(rawStartDate)) {
      details.push({
        field: "startDate",
        message: `startDate must be a valid ISO 8601 date or date-time string`,
        code: "INVALID_START_DATE",
      });
    } else {
      startDate = rawStartDate;
    }
  }

  const rawEndDate = getParam("endDate");
  let endDate: string | undefined;
  if (rawEndDate !== undefined) {
    if (!isValidIsoDate(rawEndDate)) {
      details.push({
        field: "endDate",
        message: `endDate must be a valid ISO 8601 date or date-time string`,
        code: "INVALID_END_DATE",
      });
    } else {
      endDate = rawEndDate;
    }
  }

  if (startDate && endDate) {
    const startMs = Date.parse(startDate);
    const endMs = Date.parse(endDate);
    if (startMs > endMs) {
      details.push({
        field: "startDate",
        message: `startDate must be before or equal to endDate`,
        code: "INVALID_DATE_RANGE",
      });
    }
  }

  // Parse granularity
  let granularity: AnalyticsGranularity | undefined;
  const rawGranularity = getParam("granularity");
  if (rawGranularity !== undefined) {
    if (!ALLOWED_GRANULARITIES.includes(rawGranularity as AnalyticsGranularity)) {
      details.push({
        field: "granularity",
        message: `Granularity must be one of: ${ALLOWED_GRANULARITIES.join(", ")}`,
        code: "INVALID_GRANULARITY",
      });
    } else {
      granularity = rawGranularity as AnalyticsGranularity;
    }
  }

  // Parse timeSeries
  let timeSeries: boolean | undefined;
  const rawTimeSeries = getParam("timeSeries");
  if (rawTimeSeries !== undefined) {
    if (rawTimeSeries === "true" || (typeof rawTimeSeries === "boolean" && rawTimeSeries)) {
      timeSeries = true;
    } else if (rawTimeSeries === "false" || (typeof rawTimeSeries === "boolean" && !rawTimeSeries)) {
      timeSeries = false;
    } else {
      details.push({
        field: "timeSeries",
        message: `timeSeries must be a boolean ('true' or 'false')`,
        code: "INVALID_TIME_SERIES",
      });
    }
  }

  if (details.length > 0) {
    return {
      success: false,
      status: 400,
      error: createValidationError("Invalid query parameters", details),
    };
  }

  return {
    success: true,
    data: {
      limit,
      offset,
      sort,
      order,
      category,
      status,
      owner,
      token,
      startDate,
      endDate,
      granularity,
      timeSeries,
    },
  };
}

export type AnalyticsContext = {
  proposals: Proposal[];
  ownerCount: number;
  /** Current owner addresses; lets spend-by-owner report owners with no spend. */
  owners?: string[];
  /** Indexed treasury deposits (inflow). */
  deposits?: TreasuryDeposit[];
  /** Indexed treasury balance snapshots. */
  balanceSnapshots?: BalanceSnapshot[];
};

export type AnalyticsApiResponse<T> =
  | { status: 200; data: T }
  | { status: 400 | 404 | 405 | 500; error: AnalyticsApiErrorResponse };

const MS_PER_DAY = 86_400_000;

/**
 * Route handler for GET /stats/summary
 *
 * Exposes treasury summary statistics:
 * - total disbursed per token
 * - active proposals count
 * - owner count
 * - largest single outflow
 *
 * Supports optional date range (startDate, endDate) and token filters.
 */
export function handleGetStatsSummary(
  params: URLSearchParams | Record<string, unknown> | undefined,
  context: AnalyticsContext,
): AnalyticsApiResponse<TreasurySummary> {
  const validation = parseAndValidateAnalyticsQuery(params);
  if (!validation.success) {
    return {
      status: validation.status,
      error: validation.error,
    };
  }

  const query = validation.data;
  const { proposals, ownerCount, deposits = [] } = context;

  // Active proposals are independent of the transfer date range
  const activeProposals = proposals.filter((p) =>
    ["pending", "ready"].includes(p.status),
  ).length;

  // Filter executed transfers optionally within the date range and token
  const executedTransfers = proposals.filter((p) => {
    if (p.status !== "executed" || p.kind !== "transfer") return false;

    if (query.token && p.token !== query.token) return false;

    if (query.startDate || query.endDate) {
      const ts = p.deadlineTs * 1000;
      if (query.startDate && ts < new Date(query.startDate).getTime()) {
        return false;
      }
      if (
        query.endDate &&
        ts > new Date(query.endDate).getTime() + MS_PER_DAY - 1
      ) {
        return false;
      }
    }

    return true;
  });

  const totalsByToken = new Map<string, number>();
  let largestOutflow: { token: string; amount: AnalyticsAmount } | null = null;
  let maxAmount = -1;

  for (const p of executedTransfers) {
    const token = p.token || "XLM";
    const amount = parseFloat(p.amount) || 0;
    const current = totalsByToken.get(token) ?? 0;
    totalsByToken.set(token, current + amount);

    if (amount > maxAmount) {
      maxAmount = amount;
      largestOutflow = {
        token,
        amount: String(amount),
      };
    }
  }

  const totalDisbursed: Record<string, AnalyticsAmount> = {};
  for (const [token, total] of totalsByToken.entries()) {
    totalDisbursed[token] = String(total);
  }
  const inflowsByToken = new Map<string, number>();
  for (const deposit of deposits) {
    const token = deposit.token || "XLM";
    if (query.token && token !== query.token) continue;
    if (!inDateRange(deposit.timestamp, query)) continue;
    inflowsByToken.set(
      token,
      (inflowsByToken.get(token) ?? 0) + (parseFloat(deposit.amount) || 0),
    );
  }
  const totalInflows: Record<string, AnalyticsAmount> = {};
  for (const [token, total] of inflowsByToken.entries()) {
    totalInflows[token] = formatAmount(total);
  }

  return {
    status: 200,
    data: {
      totalDisbursed,
      totalInflows,
      activeProposals,
      ownerCount,
      largestOutflow,
    },
  };
}

/** Stellar amounts have 7 decimals; trims float noise from summed values. */
function formatAmount(value: number): AnalyticsAmount {
  return String(Number(value.toFixed(7)));
}

/** Inclusive date-range check on a Unix-seconds timestamp; endDate covers its whole day. */
function inDateRange(tsSeconds: number, query: ParsedAnalyticsQuery): boolean {
  const ts = tsSeconds * 1000;
  if (query.startDate && ts < new Date(query.startDate).getTime()) return false;
  if (query.endDate && ts > new Date(query.endDate).getTime() + MS_PER_DAY - 1) {
    return false;
  }
  return true;
}

/** UTC start of the bucket containing `ms`. Weeks start on Monday. */
function bucketStart(ms: number, granularity: AnalyticsGranularity): number {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  if (granularity === "month") return Date.UTC(y, m, 1);
  const midnight = Date.UTC(y, m, day);
  if (granularity === "day") return midnight;
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  return midnight - sinceMonday * MS_PER_DAY;
}

function nextBucket(start: number, granularity: AnalyticsGranularity): number {
  if (granularity === "day") return start + MS_PER_DAY;
  if (granularity === "week") return start + 7 * MS_PER_DAY;
  const d = new Date(start);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

function proposalMatchesFilters(p: Proposal, query: ParsedAnalyticsQuery): boolean {
  if (query.token && (p.token || "XLM") !== query.token) return false;
  if (query.category && (p.category ?? "Other") !== query.category) return false;
  if (query.owner && !p.proposer.toLowerCase().includes(query.owner.toLowerCase())) {
    return false;
  }
  return inDateRange(p.deadlineTs, query);
}

/**
 * Route handler for GET /spend/by-category
 *
 * Executed transfer spend grouped by proposal category and token, with an
 * optional date range (startDate, endDate) plus token/category/owner filters.
 * `share` is the category's percentage of total spend for the same token
 * within the filtered range (0-100).
 */
export function handleGetSpendByCategory(
  params: URLSearchParams | Record<string, unknown> | undefined,
  context: AnalyticsContext,
): AnalyticsApiResponse<CategorySpendBucket[]> {
  const validation = parseAndValidateAnalyticsQuery(params);
  if (!validation.success) {
    return { status: validation.status, error: validation.error };
  }
  const query = validation.data;

  const totals = new Map<
    string,
    { category: ProposalCategory; token: string; total: number; count: number }
  >();
  for (const p of context.proposals) {
    if (p.status !== "executed" || p.kind !== "transfer") continue;
    if (!proposalMatchesFilters(p, query)) continue;
    const category = p.category ?? "Other";
    const token = p.token || "XLM";
    const key = `${category}\u0000${token}`;
    const entry = totals.get(key) ?? { category, token, total: 0, count: 0 };
    entry.total += parseFloat(p.amount) || 0;
    entry.count += 1;
    totals.set(key, entry);
  }

  const totalByToken = new Map<string, number>();
  for (const { token, total } of totals.values()) {
    totalByToken.set(token, (totalByToken.get(token) ?? 0) + total);
  }

  const rows = [...totals.values()].sort(
    (a, b) => b.total - a.total || a.category.localeCompare(b.category),
  );

  return {
    status: 200,
    data: rows.map((r) => {
      const tokenTotal = totalByToken.get(r.token) ?? 0;
      return {
        category: r.category,
        token: r.token,
        total: formatAmount(r.total),
        count: r.count,
        share: tokenTotal > 0 ? Number(((r.total / tokenTotal) * 100).toFixed(2)) : 0,
      };
    }),
  };
}

/**
 * Route handler for GET /spend/by-owner
 *
 * Executed transfer spend grouped by proposing owner and token, with an
 * optional date range (startDate, endDate) plus token/category/owner filters.
 * Owners listed in the context with no spend are returned with a zero total.
 */
export function handleGetSpendByOwner(
  params: URLSearchParams | Record<string, unknown> | undefined,
  context: AnalyticsContext,
): AnalyticsApiResponse<OwnerSpendBucket[]> {
  const validation = parseAndValidateAnalyticsQuery(params);
  if (!validation.success) {
    return { status: validation.status, error: validation.error };
  }
  const query = validation.data;

  const totals = new Map<string, { owner: string; token: string; total: number; count: number }>();
  for (const p of context.proposals) {
    if (p.status !== "executed" || p.kind !== "transfer") continue;
    if (!proposalMatchesFilters(p, query)) continue;
    const owner = p.proposer || "Unknown";
    const token = p.token || "XLM";
    const key = `${owner}\u0000${token}`;
    const entry = totals.get(key) ?? { owner, token, total: 0, count: 0 };
    entry.total += parseFloat(p.amount) || 0;
    entry.count += 1;
    totals.set(key, entry);
  }

  const rows = [...totals.values()];
  const withSpend = new Set(rows.map((r) => r.owner));
  const zeroToken = query.token ?? "XLM";
  for (const owner of context.owners ?? []) {
    if (withSpend.has(owner)) continue;
    if (query.owner && !owner.toLowerCase().includes(query.owner.toLowerCase())) continue;
    rows.push({ owner, token: zeroToken, total: 0, count: 0 });
    withSpend.add(owner);
  }

  rows.sort((a, b) => b.total - a.total || a.owner.localeCompare(b.owner));
  return {
    status: 200,
    data: rows.map((r) => ({
      owner: r.owner,
      token: r.token,
      total: formatAmount(r.total),
      count: r.count,
    })),
  };
}

/**
 * Route handler for GET /treasury/balance
 *
 * Returns the latest indexed per-token balances. With timeSeries=true, also
 * returns the snapshots in range for charting. When endDate is given, the
 * current balance is the latest snapshot on or before that day.
 */
export function handleGetTreasuryBalance(
  params: URLSearchParams | Record<string, unknown> | undefined,
  context: AnalyticsContext,
): AnalyticsApiResponse<TreasuryBalance> {
  const validation = parseAndValidateAnalyticsQuery(params);
  if (!validation.success) {
    return { status: validation.status, error: validation.error };
  }
  const query = validation.data;

  const pick = (balances: Record<string, AnalyticsAmount>) =>
    query.token
      ? query.token in balances
        ? { [query.token]: balances[query.token] }
        : {}
      : { ...balances };

  const snapshots = [...(context.balanceSnapshots ?? [])].sort(
    (a, b) => a.timestamp - b.timestamp,
  );
  const endMs = query.endDate
    ? new Date(query.endDate).getTime() + MS_PER_DAY - 1
    : Infinity;
  const current = [...snapshots].reverse().find((s) => s.timestamp * 1000 <= endMs);

  const data: TreasuryBalance = { balances: current ? pick(current.balances) : {} };
  if (query.timeSeries) {
    data.timeSeries = snapshots
      .filter((s) => inDateRange(s.timestamp, query))
      .map((s) => ({
        timestamp: new Date(s.timestamp * 1000).toISOString(),
        values: pick(s.balances),
      }));
  }
  return { status: 200, data };
}

/**
 * Route handler for GET /treasury/flow
 *
 * Inflow (deposits) vs outflow (executed transfers) per token, bucketed by
 * granularity (day | week | month, default day). Windows with no activity are
 * zero-filled. Without a date range, buckets span the first to last activity.
 */
export function handleGetTreasuryFlow(
  params: URLSearchParams | Record<string, unknown> | undefined,
  context: AnalyticsContext,
): AnalyticsApiResponse<TreasuryFlowBucket[]> {
  const validation = parseAndValidateAnalyticsQuery(params);
  if (!validation.success) {
    return { status: validation.status, error: validation.error };
  }
  const query = validation.data;
  const granularity = query.granularity ?? "day";

  type Event = { ms: number; token: string; inflow: number; outflow: number };
  const events: Event[] = [];
  for (const d of context.deposits ?? []) {
    const token = d.token || "XLM";
    if (query.token && token !== query.token) continue;
    if (!inDateRange(d.timestamp, query)) continue;
    events.push({ ms: d.timestamp * 1000, token, inflow: parseFloat(d.amount) || 0, outflow: 0 });
  }
  for (const p of context.proposals) {
    if (p.status !== "executed" || p.kind !== "transfer") continue;
    const token = p.token || "XLM";
    if (query.token && token !== query.token) continue;
    if (!inDateRange(p.deadlineTs, query)) continue;
    events.push({ ms: p.deadlineTs * 1000, token, inflow: 0, outflow: parseFloat(p.amount) || 0 });
  }

  const tokens = new Set(events.map((e) => e.token));
  if (query.token) tokens.add(query.token);
  if (tokens.size === 0) return { status: 200, data: [] };

  const times = events.map((e) => e.ms);
  const rangeStart = query.startDate
    ? new Date(query.startDate).getTime()
    : times.length
      ? Math.min(...times)
      : undefined;
  const rangeEnd = query.endDate
    ? new Date(query.endDate).getTime()
    : times.length
      ? Math.max(...times)
      : undefined;
  if (rangeStart === undefined || rangeEnd === undefined || rangeStart > rangeEnd) {
    return { status: 200, data: [] };
  }

  const sums = new Map<string, { inflow: number; outflow: number }>();
  for (const e of events) {
    const key = `${bucketStart(e.ms, granularity)}\u0000${e.token}`;
    const entry = sums.get(key) ?? { inflow: 0, outflow: 0 };
    entry.inflow += e.inflow;
    entry.outflow += e.outflow;
    sums.set(key, entry);
  }

  const data: TreasuryFlowBucket[] = [];
  const sortedTokens = [...tokens].sort();
  const last = bucketStart(rangeEnd, granularity);
  for (let t = bucketStart(rangeStart, granularity); t <= last; t = nextBucket(t, granularity)) {
    for (const token of sortedTokens) {
      const entry = sums.get(`${t}\u0000${token}`);
      data.push({
        timestamp: new Date(t).toISOString(),
        token,
        inflow: formatAmount(entry?.inflow ?? 0),
        outflow: formatAmount(entry?.outflow ?? 0),
      });
    }
  }
  return { status: 200, data };
}

/**
 * Universal router dispatcher for Analytics API endpoints.
 * Validates HTTP method, parses shared query parameters, and routes to appropriate handler.
 */
export function handleAnalyticsRoute(
  method: string,
  pathname: string,
  rawParams: URLSearchParams | Record<string, unknown> | undefined,
  context: AnalyticsContext,
): AnalyticsApiResponse<unknown> {
  if (method.toUpperCase() !== "GET") {
    return {
      status: 405,
      error: createErrorResponse("METHOD_NOT_ALLOWED", `HTTP method ${method} not allowed`),
    };
  }

  // Normalize path
  const normalizedPath = pathname.replace(/\/+$/, "") || "/";

  switch (normalizedPath) {
    case "/stats/summary":
      return handleGetStatsSummary(rawParams, context);

    case "/spend/by-category":
      return handleGetSpendByCategory(rawParams, context);

    case "/spend/by-owner":
      return handleGetSpendByOwner(rawParams, context);

    case "/treasury/balance":
      return handleGetTreasuryBalance(rawParams, context);

    case "/treasury/flow":
      return handleGetTreasuryFlow(rawParams, context);

    default:
      return {
        status: 404,
        error: createErrorResponse("NOT_FOUND", `Endpoint ${pathname} not found`),
      };
  }
}
