export type WebhookTargetType = "zapier" | "generic";

export type WorkflowTriggerEvent =
  | "proposal.created"
  | "proposal.approved"
  | "proposal.executed"
  | "treasury.disbursed"
  | "alert.fired";

export const WORKFLOW_TRIGGERS: Array<{ event: WorkflowTriggerEvent; label: string }> = [
  { event: "proposal.created", label: "Proposal created" },
  { event: "proposal.approved", label: "Proposal approved" },
  { event: "proposal.executed", label: "Proposal executed" },
  { event: "treasury.disbursed", label: "Treasury disbursed" },
  { event: "alert.fired", label: "Alert rule fired" },
];

export type WorkflowWebhook = {
  id: number;
  network: string;
  contractId: string;
  name: string;
  targetType: WebhookTargetType;
  url: string;
  events: WorkflowTriggerEvent[];
  enabled: boolean;
  createdAt: string;
};

export type CreateWebhookDraft = {
  name: string;
  targetType: WebhookTargetType;
  url: string;
  events: WorkflowTriggerEvent[];
};

const PRIVATE_HOST_RE = /^(localhost|127\.0\.0\.1|::1|10\.|192\.168\.|169\.254\.)/i;

export function isValidWebhookUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("https://") || /\s/.test(trimmed)) {
    return false;
  }
  try {
    const parsed = new URL(trimmed);
    return (
      parsed.protocol === "https:" &&
      Boolean(parsed.hostname) &&
      !PRIVATE_HOST_RE.test(parsed.hostname) &&
      !parsed.hostname.endsWith(".local")
    );
  } catch {
    return false;
  }
}

export function validateWebhookDraft(draft: CreateWebhookDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  const name = draft.name.trim();
  if (!name || name.length > 80) {
    errors.name = "Webhook name must be between 1 and 80 characters.";
  }
  if (!isValidWebhookUrl(draft.url)) {
    errors.url = "Webhook URL must be a public https:// endpoint.";
  }
  if (draft.events.length === 0) {
    errors.events = "Select at least one trigger event.";
  }
  return errors;
}

function apiBaseUrl(): string {
  return (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/+$/, "") ?? "";
}

export async function listWorkflowWebhooks(
  contractId: string,
  network = "testnet",
): Promise<WorkflowWebhook[]> {
  const base = apiBaseUrl();
  if (!base) return [];
  const params = new URLSearchParams({ contractId, network });
  const res = await fetch(`${base}/workflows/webhooks?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`Failed to load workflow webhooks (${res.status})`);
  }
  const data = (await res.json()) as { items?: WorkflowWebhook[] };
  return data.items ?? [];
}

export async function createWorkflowWebhook(
  contractId: string,
  network: string,
  draft: CreateWebhookDraft,
  adminToken?: string,
): Promise<WorkflowWebhook> {
  const base = apiBaseUrl();
  if (!base) {
    throw new Error("Analytics API base URL is not configured.");
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (adminToken) {
    headers.Authorization = `Bearer ${adminToken}`;
  }
  const params = new URLSearchParams({ contractId, network });
  const res = await fetch(`${base}/workflows/webhooks?${params.toString()}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: draft.name.trim(),
      targetType: draft.targetType,
      url: draft.url.trim(),
      events: draft.events,
    }),
  });
  if (!res.ok) {
    const errBody = (await res.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    throw new Error(errBody?.error?.message ?? `Failed to create webhook (${res.status})`);
  }
  return (await res.json()) as WorkflowWebhook;
}

export async function deleteWorkflowWebhook(
  id: number,
  contractId: string,
  network: string,
  adminToken?: string,
): Promise<void> {
  const base = apiBaseUrl();
  if (!base) {
    throw new Error("Analytics API base URL is not configured.");
  }
  const headers: Record<string, string> = {};
  if (adminToken) {
    headers.Authorization = `Bearer ${adminToken}`;
  }
  const params = new URLSearchParams({ contractId, network });
  const res = await fetch(`${base}/workflows/webhooks/${id}?${params.toString()}`, {
    method: "DELETE",
    headers,
  });
  if (!res.ok) {
    throw new Error(`Failed to delete webhook (${res.status})`);
  }
}

export async function testWorkflowWebhook(
  id: number,
  contractId: string,
  network: string,
  adminToken?: string,
): Promise<{ eventType: string; dispatched: boolean }> {
  const base = apiBaseUrl();
  if (!base) {
    throw new Error("Analytics API base URL is not configured.");
  }
  const headers: Record<string, string> = {};
  if (adminToken) {
    headers.Authorization = `Bearer ${adminToken}`;
  }
  const params = new URLSearchParams({ contractId, network });
  const res = await fetch(`${base}/workflows/webhooks/${id}/test?${params.toString()}`, {
    method: "POST",
    headers,
  });
  if (!res.ok) {
    throw new Error(`Failed to send test trigger (${res.status})`);
  }
  return (await res.json()) as { eventType: string; dispatched: boolean };
}
