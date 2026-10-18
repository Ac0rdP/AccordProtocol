import type { AnalyticsQuery } from "../types/accord";

export const ANALYTICS_LIMITS = {
  maxDateLength: 30,
  maxTokenLength: 32,
  maxOwnerLength: 128,
  maxLimit: 100,
  maxOffset: 1_000_000,
  requestsPerMinute: 60,
} as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/;

export function validateAnalyticsQuery(query: AnalyticsQuery = {}): AnalyticsQuery {
  if (query.startDate !== undefined && (!ISO_DATE.test(query.startDate) || query.startDate.length > ANALYTICS_LIMITS.maxDateLength)) {
    throw new RangeError("startDate must be an ISO date or UTC date-time");
  }
  if (query.endDate !== undefined && (!ISO_DATE.test(query.endDate) || query.endDate.length > ANALYTICS_LIMITS.maxDateLength)) {
    throw new RangeError("endDate must be an ISO date or UTC date-time");
  }
  if (query.startDate && query.endDate && query.startDate > query.endDate) {
    throw new RangeError("startDate must not be after endDate");
  }
  if (query.token !== undefined && (!/^[A-Za-z0-9._-]+$/.test(query.token) || query.token.length > ANALYTICS_LIMITS.maxTokenLength)) {
    throw new RangeError("token contains invalid characters or is too long");
  }
  if (query.owner !== undefined && query.owner.length > ANALYTICS_LIMITS.maxOwnerLength) {
    throw new RangeError("owner is too long");
  }
  if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > ANALYTICS_LIMITS.maxLimit)) {
    throw new RangeError(`limit must be an integer between 1 and ${ANALYTICS_LIMITS.maxLimit}`);
  }
  if (query.offset !== undefined && (!Number.isInteger(query.offset) || query.offset < 0 || query.offset > ANALYTICS_LIMITS.maxOffset)) {
    throw new RangeError(`offset must be an integer between 0 and ${ANALYTICS_LIMITS.maxOffset}`);
  }
  return query;
}

export class AnalyticsRateLimitError extends Error {
  readonly status = 429;

  constructor() {
    super("Analytics request rate limit exceeded");
    this.name = "AnalyticsRateLimitError";
  }
}

export function createRateLimiter(limit: number = ANALYTICS_LIMITS.requestsPerMinute, now = () => Date.now()) {
  let windowStart = now();
  let requests = 0;
  return () => {
    const current = now();
    if (current - windowStart >= 60_000) {
      windowStart = current;
      requests = 0;
    }
    if (requests >= limit) throw new AnalyticsRateLimitError();
    requests += 1;
  };
}
