export type NotificationDestinationKind = "webhook" | "slack" | "discord" | "email";

export type NotificationDestinationConfig = {
  url?: string;
  secret?: string;
  webhookUrl?: string;
  to?: string;
};

export type NotificationDestination = {
  id: string;
  kind: NotificationDestinationKind;
  config: NotificationDestinationConfig;
  topics: string[] | null;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type TestDestinationResult = {
  ok: boolean;
  statusCode?: number | null;
  error?: string | null;
};

function indexerBase(): string {
  return import.meta.env.VITE_INDEXER_API_BASE_URL || "";
}

async function parseJsonOrThrow(res: Response) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.error || `Request failed with HTTP ${res.status}`);
  }
  return body;
}

export async function listNotificationDestinations(): Promise<NotificationDestination[]> {
  const res = await fetch(`${indexerBase()}/notifications/destinations`);
  const body = await parseJsonOrThrow(res);
  return body.destinations ?? [];
}

export async function saveNotificationDestination(
  destination: Omit<NotificationDestination, "createdAt" | "updatedAt">,
): Promise<NotificationDestination> {
  const res = await fetch(
    `${indexerBase()}/notifications/destinations/${encodeURIComponent(destination.id)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(destination),
    },
  );
  const body = await parseJsonOrThrow(res);
  return body.destination;
}

export async function deleteNotificationDestination(id: string): Promise<void> {
  const res = await fetch(`${indexerBase()}/notifications/destinations/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 204) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error || `Request failed with HTTP ${res.status}`);
  }
}

export async function testNotificationDestination(id: string): Promise<TestDestinationResult> {
  const res = await fetch(`${indexerBase()}/notifications/destinations/${encodeURIComponent(id)}/test`, {
    method: "POST",
  });
  return res.json();
}
