export type PlanTier = "free" | "pro" | "enterprise";

export type PlanLimits = {
  workspacesLimit: number;
  apiRequestsLimit: number;
  reportsLimit: number;
  integrationsLimit: number;
  monthlyPriceUsd: number;
};

export type WorkspacePlan = {
  network: string;
  contractId: string;
  planTier: PlanTier;
  workspacesLimit: number;
  apiRequestsUsed: number;
  apiRequestsLimit: number;
  reportsUsed: number;
  reportsLimit: number;
  integrationsUsed: number;
  integrationsLimit: number;
  billingEmail: string | null;
  status: "active" | "past_due" | "canceled";
};

export type BillingSummary = {
  plan: WorkspacePlan;
  catalog: Array<{ tier: PlanTier; limits: PlanLimits }>;
};

export const DEFAULT_PLAN_CATALOG: Array<{ tier: PlanTier; limits: PlanLimits }> = [
  {
    tier: "free",
    limits: {
      workspacesLimit: 1,
      apiRequestsLimit: 10_000,
      reportsLimit: 5,
      integrationsLimit: 2,
      monthlyPriceUsd: 0,
    },
  },
  {
    tier: "pro",
    limits: {
      workspacesLimit: 5,
      apiRequestsLimit: 250_000,
      reportsLimit: 100,
      integrationsLimit: 25,
      monthlyPriceUsd: 49,
    },
  },
  {
    tier: "enterprise",
    limits: {
      workspacesLimit: 50,
      apiRequestsLimit: 5_000_000,
      reportsLimit: 2_000,
      integrationsLimit: 500,
      monthlyPriceUsd: 299,
    },
  },
];

export function usagePercent(used: number, limit: number): number {
  if (limit <= 0) return 100;
  return Math.min(100, Math.round((used / limit) * 100));
}

export function isNearQuota(used: number, limit: number): boolean {
  return usagePercent(used, limit) >= 80;
}

export function nextUpgradeTier(current: PlanTier): PlanTier | null {
  if (current === "free") return "pro";
  if (current === "pro") return "enterprise";
  return null;
}

export function isValidBillingEmail(email: string): boolean {
  const trimmed = email.trim();
  if (!trimmed) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

function apiBaseUrl(): string {
  return (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/+$/, "") ?? "";
}

export async function fetchBillingSummary(
  contractId: string,
  network = "testnet",
): Promise<BillingSummary | null> {
  const base = apiBaseUrl();
  if (!base) return null;
  const params = new URLSearchParams({ contractId, network });
  const res = await fetch(`${base}/billing?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`Failed to load billing summary (${res.status})`);
  }
  return (await res.json()) as BillingSummary;
}

export async function updateBillingPlan(
  contractId: string,
  network: string,
  planTier: PlanTier,
  billingEmail?: string,
  adminToken?: string,
): Promise<BillingSummary> {
  const base = apiBaseUrl();
  if (!base) {
    throw new Error("Analytics API base URL is not configured.");
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (adminToken) {
    headers.Authorization = `Bearer ${adminToken}`;
  }
  const params = new URLSearchParams({ contractId, network });
  const res = await fetch(`${base}/billing/plan?${params.toString()}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      planTier,
      billingEmail: billingEmail?.trim() || null,
    }),
  });
  if (!res.ok) {
    const errBody = (await res.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    throw new Error(errBody?.error?.message ?? `Failed to update plan (${res.status})`);
  }
  return (await res.json()) as BillingSummary;
}
