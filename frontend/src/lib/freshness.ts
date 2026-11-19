/** Client for `GET /freshness`: data freshness and API latency against SLOs. */

export type FreshnessStatus = "ok" | "breach" | "unknown";

export type FreshnessItem = {
  network: string;
  contractId: string;
  lastLedger: number | null;
  lastCheckpointAt: string | null;
  ingestionLagSeconds: number | null;
  ingestionStatus: FreshnessStatus;
  lastReportAt: string | null;
  reportAgeSeconds: number | null;
  reportStatus: FreshnessStatus;
  status: FreshnessStatus;
};

export type Freshness = {
  generatedAt: string;
  slo: { ingestionLagSeconds: number; apiP95Ms: number; reportMaxAgeSeconds: number };
  status: FreshnessStatus;
  api: { requests: number; p50Ms: number | null; p95Ms: number | null; status: FreshnessStatus };
  items: FreshnessItem[];
  total: number;
  limit: number;
  offset: number;
};

export async function fetchFreshness(
  signal?: AbortSignal,
  baseUrl: string = import.meta.env.VITE_API_BASE_URL || "",
): Promise<Freshness> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/freshness?limit=100`, {
    headers: { Accept: "application/json" },
    signal,
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Freshness request failed (${response.status})`);
  }
  if (!response.ok) {
    const message = (body as { error?: { message?: string } })?.error?.message;
    throw new Error(message ?? `Freshness request failed (${response.status})`);
  }
  return body as Freshness;
}

/** "45s", "12m", "3h 5m", "2d 4h": how long ago, at a glance. */
export function formatAge(seconds: number | null): string {
  if (seconds === null) return "never";
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m`;
  if (total < 86_400) return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`;
  return `${Math.floor(total / 86_400)}d ${Math.floor((total % 86_400) / 3600)}h`;
}
