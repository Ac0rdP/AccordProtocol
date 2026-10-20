import { SIGNATURE_HEADER, signPayload, computeBackoffMs } from "./webhooks.js";

const DESTINATION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MIN_SECRET_LENGTH = 16;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KINDS = ["webhook", "slack", "discord", "email"];

function requireHttpsUrl(value, { allowLocalHttp = false, label }) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (url.protocol !== "https:" && !(allowLocalHttp && url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) {
    throw new Error(`${label} must be https${allowLocalHttp ? " (http is only allowed for localhost)" : ""}`);
  }
  return url.toString();
}

/** Validates and normalizes the kind-specific `config` object for a destination. */
export function validateDestinationConfig(kind, config, { env = process.env } = {}) {
  if (config === null || typeof config !== "object") throw new Error("config must be an object");

  switch (kind) {
    case "webhook": {
      const url = requireHttpsUrl(config.url, { allowLocalHttp: true, label: "webhook url" });
      const secret = config.secretEnv ? env[config.secretEnv] : config.secret;
      if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) {
        throw new Error(`webhook secret must be at least ${MIN_SECRET_LENGTH} characters`);
      }
      return { url, secret };
    }
    case "slack":
    case "discord": {
      const webhookUrl = requireHttpsUrl(config.webhookUrl, { label: `${kind} webhookUrl` });
      return { webhookUrl };
    }
    case "email": {
      if (typeof config.to !== "string" || !EMAIL_RE.test(config.to)) {
        throw new Error("email destination requires a valid 'to' address");
      }
      return { to: config.to };
    }
    default:
      throw new Error(`destination kind must be one of: ${KINDS.join(", ")}`);
  }
}

/**
 * Validates one destination entry:
 *   { id, kind, config, topics?: string[], enabled?: boolean }
 */
export function parseDestination(entry, { env = process.env } = {}) {
  if (entry === null || typeof entry !== "object") throw new Error("destination must be an object");
  const { id, kind, topics } = entry;
  if (typeof id !== "string" || !DESTINATION_ID.test(id)) {
    throw new Error("destination id must be 1-64 characters of letters, digits, '-' or '_'");
  }
  if (!KINDS.includes(kind)) throw new Error(`destination ${id}: kind must be one of: ${KINDS.join(", ")}`);
  if (topics !== undefined && (!Array.isArray(topics) || topics.some((t) => typeof t !== "string" || !t))) {
    throw new Error(`destination ${id}: topics must be an array of event topic names`);
  }
  const config = validateDestinationConfig(kind, entry.config ?? {}, { env });
  return {
    id,
    kind,
    config,
    topics: topics?.length ? [...topics] : null,
    enabled: entry.enabled !== false,
  };
}

/** Parses a whole array of destination entries, same shape as `parseDestination`. */
export function parseDestinations(raw, options = {}) {
  if (!Array.isArray(raw)) throw new Error("destinations must be a JSON array");
  const seen = new Set();
  const destinations = [];
  for (const entry of raw) {
    const destination = parseDestination(entry, options);
    if (seen.has(destination.id)) throw new Error(`duplicate destination id ${destination.id}`);
    seen.add(destination.id);
    destinations.push(destination);
  }
  return destinations;
}

function truncate(text, max = 480) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function describeEvent(event) {
  const parts = [`${event.topic} on ledger ${event.ledger}`];
  if (event.transactionHash) parts.push(`tx ${event.transactionHash}`);
  return truncate(`[Accord] ${parts.join(", ")} at ${event.occurredAt}`);
}

/** The JSON body stored in the outbox and sent verbatim on every retry. */
export function buildNotificationBody(kind, destinationId, event) {
  switch (kind) {
    case "webhook":
      return JSON.stringify({
        id: event.eventId,
        type: event.topic,
        destination: destinationId,
        ledger: event.ledger,
        transactionHash: event.transactionHash,
        occurredAt: event.occurredAt,
        data: event.payload,
      });
    case "slack":
      return JSON.stringify({ text: describeEvent(event) });
    case "discord":
      return JSON.stringify({ content: describeEvent(event) });
    case "email":
      return JSON.stringify({
        subject: `Accord event: ${event.topic}`,
        text: describeEvent(event),
      });
    default:
      throw new Error(`unknown destination kind: ${kind}`);
  }
}

/**
 * Default email transport: posts to a provider-agnostic HTTP API configured
 * via `EMAIL_API_URL` (and optionally `EMAIL_API_KEY`, `EMAIL_FROM`). Any
 * transactional email provider that accepts a simple JSON POST can sit behind
 * that URL; swap in a different `mailer` for anything else (e.g. SMTP).
 */
export function createDefaultMailer({ fetchImpl = fetch, env = process.env, timeoutMs = 10_000 } = {}) {
  return {
    async send({ to, subject, text }) {
      const apiUrl = env.EMAIL_API_URL?.trim();
      if (!apiUrl) throw new Error("email delivery is not configured (set EMAIL_API_URL)");
      const response = await fetchImpl(apiUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(env.EMAIL_API_KEY ? { authorization: `Bearer ${env.EMAIL_API_KEY}` } : {}),
        },
        body: JSON.stringify({ from: env.EMAIL_FROM || undefined, to, subject, text }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`email API responded with HTTP ${response.status}`);
    },
  };
}

/** Sends one delivery attempt for `destination`; returns `{statusCode, error}` (both null on success). */
async function dispatchOne({ destination, delivery, attempts, fetchImpl, mailer, now, timeoutMs }) {
  if (destination.kind === "email") {
    const { to, subject, text } = JSON.parse(delivery.body);
    try {
      await mailer.send({ to: destination.config.to ?? to, subject, text });
      return { statusCode: null, error: null };
    } catch (cause) {
      return { statusCode: null, error: String(cause?.message ?? cause) };
    }
  }

  const url = destination.kind === "webhook" ? destination.config.url : destination.config.webhookUrl;
  const headers = { "content-type": "application/json" };
  if (destination.kind === "webhook") {
    headers["user-agent"] = "accord-indexer-notifications/1";
    headers[SIGNATURE_HEADER] = signPayload({
      secret: destination.config.secret,
      body: delivery.body,
      timestamp: Math.floor(now() / 1000),
    });
    headers["x-accord-event-id"] = delivery.eventId;
    headers["x-accord-delivery-id"] = String(delivery.id);
    headers["x-accord-delivery-attempt"] = String(attempts);
  }

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: delivery.body,
      // A redirect would re-send the body to a host the operator never configured.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel().catch(() => {});
    if (response.status < 200 || response.status >= 300) {
      return { statusCode: response.status, error: `receiver responded with HTTP ${response.status}` };
    }
    return { statusCode: response.status, error: null };
  } catch (cause) {
    const error = cause?.name === "TimeoutError" ? `timed out after ${timeoutMs}ms` : String(cause?.message ?? cause);
    return { statusCode: null, error };
  }
}

/**
 * Sends a synthetic test event to `destination` immediately, bypassing the
 * durable queue entirely. Used by the "test this destination" settings-UI
 * action, so a misconfigured secret or URL surfaces right away.
 */
export async function sendTestNotification(destination, { fetchImpl = fetch, mailer, now = () => Date.now(), timeoutMs = 10_000 } = {}) {
  const testEvent = {
    eventId: `test-${destination.id}-${now()}`,
    topic: "notification.test",
    ledger: 0,
    transactionHash: null,
    occurredAt: new Date(now()).toISOString(),
    payload: { message: `Test notification for destination ${destination.id}` },
  };
  const body = buildNotificationBody(destination.kind, destination.id, testEvent);
  const mailerImpl = mailer ?? createDefaultMailer({ fetchImpl });
  const result = await dispatchOne({
    destination,
    delivery: { id: "test", eventId: testEvent.eventId, body },
    attempts: 1,
    fetchImpl,
    mailer: mailerImpl,
    now,
    timeoutMs,
  });
  return { ok: !result.error, ...result };
}

/**
 * Multi-channel delivery worker: consumes indexed events and dispatches them
 * to configured destinations (email, webhook, Slack, Discord), each through
 * its own durable retry queue (`notification_deliveries`), kept separate from
 * `webhook_deliveries` so the two outboxes never compete to claim rows.
 *
 * Same outbox shape as `createWebhookDispatcher` in `./webhooks.js`: each tick
 * (1) copies new events past a per-destination cursor into the outbox,
 * atomically with moving the cursor, then (2) sends whatever is due.
 */
export function createNotificationDispatcher({
  store,
  metrics,
  fetchImpl = fetch,
  mailer = createDefaultMailer({ fetchImpl }),
  now = () => Date.now(),
  random = Math.random,
  maxAttempts = 8,
  backoffBaseMs = 5000,
  backoffMaxMs = 3_600_000,
  timeoutMs = 10_000,
  batchSize = 200,
  logger = console,
} = {}) {
  let timer = null;
  let ticking = false;

  async function loadDestinations() {
    const rows = await store.listNotificationDestinations();
    return rows.filter((row) => row.enabled);
  }

  async function enqueueNew(destination) {
    const cursorKey = `notification_cursor:${destination.id}`;
    let cursor = await store.getState(cursorKey);
    if (cursor === null) {
      // A newly added destination starts at "now"; it is not sent the whole history.
      await store.setState(cursorKey, await store.getLatestAccordEventId());
      return 0;
    }
    cursor = Number(cursor);

    let enqueued = 0;
    for (;;) {
      const events = await store.getAccordEventsAfter(cursor, batchSize);
      if (events.length === 0) return enqueued;
      const matching = destination.topics ? events.filter((event) => destination.topics.includes(event.topic)) : events;
      cursor = events[events.length - 1].id;
      enqueued += await store.enqueueNotificationDeliveries({
        destinationId: destination.id,
        deliveries: matching.map((event) => ({
          eventId: event.eventId,
          body: buildNotificationBody(destination.kind, destination.id, event),
        })),
        cursor,
        now: new Date(now()).toISOString(),
      });
      if (events.length < batchSize) return enqueued;
    }
  }

  async function attempt(delivery, bySubscription) {
    const destination = bySubscription.get(delivery.destinationId);
    const nowIso = new Date(now()).toISOString();
    const attempts = delivery.attempts + 1;

    if (!destination) {
      await store.completeNotificationDelivery({
        id: delivery.id, outcome: "dead", attempts, error: "destination is no longer configured", now: nowIso,
      });
      metrics?.notificationDeliveries.inc({ destination: delivery.destinationId, kind: "unknown", result: "dead" });
      return "dead";
    }

    const startedAt = performance.now();
    const { statusCode, error } = await dispatchOne({ destination, delivery, attempts, fetchImpl, mailer, now, timeoutMs });
    metrics?.notificationDeliveryDuration.observe(
      { destination: destination.id, kind: destination.kind },
      (performance.now() - startedAt) / 1000
    );

    const completedAt = new Date(now()).toISOString();
    let outcome = "delivered";
    let nextAttemptAt;
    if (error) {
      outcome = attempts >= maxAttempts ? "dead" : "retry";
      if (outcome === "retry") {
        nextAttemptAt = new Date(
          now() + computeBackoffMs(attempts, { baseMs: backoffBaseMs, maxMs: backoffMaxMs, random })
        ).toISOString();
      }
    }
    await store.completeNotificationDelivery({
      id: delivery.id, outcome, attempts, nextAttemptAt, statusCode, error: error?.slice(0, 500), now: completedAt,
    });
    metrics?.notificationDeliveries.inc({ destination: destination.id, kind: destination.kind, result: outcome });
    if (outcome === "dead") {
      logger.error(`[notifications] ${destination.id} (${destination.kind}): delivery ${delivery.id} moved to the dead-letter queue: ${error}`);
    }
    return outcome;
  }

  async function deliverDue(bySubscription) {
    const due = await store.claimDueNotificationDeliveries({ now: new Date(now()).toISOString(), limit: batchSize });
    // Destinations deliver in parallel; within one, events go out in order.
    const groups = new Map();
    for (const delivery of due) {
      if (!groups.has(delivery.destinationId)) groups.set(delivery.destinationId, []);
      groups.get(delivery.destinationId).push(delivery);
    }
    const tally = { delivered: 0, retry: 0, dead: 0 };
    await Promise.all([...groups.values()].map(async (group) => {
      for (const delivery of group) tally[await attempt(delivery, bySubscription)] += 1;
    }));
    return tally;
  }

  async function tick() {
    if (ticking) return null;
    ticking = true;
    try {
      const destinations = await loadDestinations();
      const bySubscription = new Map(destinations.map((destination) => [destination.id, destination]));

      let enqueued = 0;
      for (const destination of destinations) enqueued += await enqueueNew(destination);
      const tally = await deliverDue(bySubscription);

      if (metrics) {
        const counts = await store.countNotificationDeliveries();
        for (const [status, count] of Object.entries(counts)) metrics.notificationBacklog.set({ status }, count);
      }
      return { enqueued, ...tally };
    } catch (error) {
      metrics?.errors.inc({ stage: "notifications" });
      logger.error("Notification dispatch failed:", error);
      return null;
    } finally {
      ticking = false;
    }
  }

  return {
    tick,
    start(intervalMs = 2000) {
      if (timer) return;
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
