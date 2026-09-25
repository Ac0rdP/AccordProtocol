import type {
  AnalyticsAmount,
  AnalyticsApiErrorDetail,
  AnalyticsApiErrorResponse,
  AnalyticsGranularity,
  AnalyticsQuery,
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
  let limit = QUERY_DEFAULTS.LIMIT;
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
  let offset = QUERY_DEFAULTS.OFFSET;
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
  const { proposals, ownerCount } = context;

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

  return {
    status: 200,
    data: {
      totalDisbursed,
      activeProposals,
      ownerCount,
      largestOutflow,
    },
  };
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

    default:
      return {
        status: 404,
        error: createErrorResponse("NOT_FOUND", `Endpoint ${pathname} not found`),
      };
  }
}
