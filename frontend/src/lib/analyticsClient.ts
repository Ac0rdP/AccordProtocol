import type {
  AnalyticsProposalDetail, AnalyticsProposalPage, AnalyticsQuery,
  CategorySpendBucket, OwnerSpendBucket, TreasuryBalance,
  TreasuryFlowBucket, TreasurySummary,
} from "../types/accord";
import { createRateLimiter, validateAnalyticsQuery } from "./analyticsSecurity";

export class AnalyticsApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly body?: unknown) {
    super(message);
    this.name = "AnalyticsApiError";
  }
}

/** Stable serialization also lets hooks compare filters by value. */
export function buildAnalyticsQuery(query: AnalyticsQuery = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query).sort(([a], [b]) => a.localeCompare(b))) {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  }
  return params.toString();
}

export type AnalyticsClientOptions = {
  /** Token for protected routes. Never put a service credential in Vite env vars. */
  accessToken?: string;
  /** Disable only for tests or when the server owns throttling in a trusted environment. */
  rateLimit?: number;
};

export function createAnalyticsClient(baseUrl = import.meta.env.VITE_API_BASE_URL || "", options: AnalyticsClientOptions = {}) {
  const consumeRequest = createRateLimiter(options.rateLimit);
  async function get<T>(path: string, query: AnalyticsQuery = {}, signal?: AbortSignal): Promise<T> {
    validateAnalyticsQuery(query);
    consumeRequest();
    const search = buildAnalyticsQuery(query);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.accessToken) headers.Authorization = `Bearer ${options.accessToken}`;
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}${search ? `?${search}` : ""}`, {
      headers, signal,
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new AnalyticsApiError(
        response.ok ? `Invalid JSON from ${path}` : `Analytics request failed (${response.status})`,
        response.status,
      );
    }
    if (!response.ok) {
      let message = `Analytics request failed (${response.status})`;
      if (body && typeof body === "object") {
        const error = "error" in body ? body.error : body;
        if (typeof error === "string") message = error;
        else if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
          message = error.message;
        }
      }
      throw new AnalyticsApiError(message, response.status, body);
    }
    return body as T;
  }
  return {
    getProposals: (query?: AnalyticsQuery, signal?: AbortSignal) => get<AnalyticsProposalPage>("/proposals", query, signal),
    getProposal: (id: number | string, signal?: AbortSignal) => get<AnalyticsProposalDetail>(`/proposals/${encodeURIComponent(id)}`, {}, signal),
    getSpendByCategory: (query?: AnalyticsQuery, signal?: AbortSignal) => get<CategorySpendBucket[]>("/spend/by-category", query, signal),
    getSpendByOwner: (query?: AnalyticsQuery, signal?: AbortSignal) => get<OwnerSpendBucket[]>("/spend/by-owner", query, signal),
    getBalance: (query?: AnalyticsQuery, signal?: AbortSignal) => get<TreasuryBalance>("/treasury/balance", query, signal),
    getFlow: (query?: AnalyticsQuery, signal?: AbortSignal) => get<TreasuryFlowBucket[]>("/treasury/flow", query, signal),
    getSummary: (query?: AnalyticsQuery, signal?: AbortSignal) => get<TreasurySummary>("/stats/summary", query, signal),
  };
}

export const analyticsClient = createAnalyticsClient();
