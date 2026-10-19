import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

export const SIGNATURE_HEADER = "x-accord-signature";
export const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300;

const SUBSCRIPTION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MIN_SECRET_LENGTH = 16;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Validates subscription config. Each entry:
 *   { id, url, secret | secretEnv, topics?: string[], enabled?: boolean }
 * `secretEnv` names an environment variable holding the secret, which keeps it
 * out of a config file that may be committed or shared.
 */
export function parseSubscriptions(raw, { env = process.env } = {}) {
  if (!Array.isArray(raw)) throw new Error("webhook subscriptions must be a JSON array");
  const seen = new Set();
  const subscriptions = [];

  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") throw new Error("each webhook subscription must be an object");
    const { id, url, topics } = entry;
    if (typeof id !== "string" || !SUBSCRIPTION_ID.test(id)) {
      throw new Error("webhook subscription id must be 1-64 characters of letters, digits, '-' or '_'");
    }
    if (seen.has(id)) throw new Error(`duplicate webhook subscription id ${id}`);
    seen.add(id);
    if (entry.enabled === false) continue;

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`webhook ${id}: url is not a valid URL`);
    }
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && LOCAL_HOSTS.has(parsed.hostname))) {
      throw new Error(`webhook ${id}: url must be https (http is only allowed for localhost)`);
    }

    const secret = entry.secretEnv ? env[entry.secretEnv] : entry.secret;
    if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) {
      throw new Error(`webhook ${id}: secret must be at least ${MIN_SECRET_LENGTH} characters`);
    }
    if (topics !== undefined && (!Array.isArray(topics) || topics.some((topic) => typeof topic !== "string" || !topic))) {
      throw new Error(`webhook ${id}: topics must be an array of event topic names`);
    }

    subscriptions.push({ id, url: parsed.toString(), secret, topics: topics?.length ? [...topics] : null });
  }
  return subscriptions;
}

/** Reads `WEBHOOK_SUBSCRIPTIONS_FILE` (a JSON file) or inline `WEBHOOK_SUBSCRIPTIONS`; none configured means no webhooks. */
export function loadSubscriptions(env = process.env) {
  const file = env.WEBHOOK_SUBSCRIPTIONS_FILE?.trim();
  const inline = env.WEBHOOK_SUBSCRIPTIONS?.trim();
  if (!file && !inline) return [];
  let raw;
  try {
    raw = JSON.parse(file ? readFileSync(file, "utf8") : inline);
  } catch (error) {
    throw new Error(`could not read webhook subscriptions: ${error.message}`);
  }
  return parseSubscriptions(raw, { env });
}

function hmac(secret, timestamp, body) {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/**
 * Builds the `X-Accord-Signature` value: `t=<unix seconds>,v1=<hex HMAC-SHA256>`,
 * where the HMAC covers `<t>.<raw body>`. Binding the timestamp into the MAC is
 * what lets receivers reject replays of an old, validly signed delivery.
 */
export function signPayload({ secret, body, timestamp = Math.floor(Date.now() / 1000) }) {
  return `t=${timestamp},v1=${hmac(secret, timestamp, body)}`;
}

/**
 * Receiver-side check. `body` must be the raw request bytes as a string, not a
 * re-serialized object. Returns `{ valid, reason? }`.
 */
export function verifySignature({
  secret,
  header,
  body,
  toleranceSeconds = DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
  now = Math.floor(Date.now() / 1000),
}) {
  const parts = String(header ?? "").split(",").map((part) => part.trim().split("="));
  const timestamp = Number(parts.find(([key]) => key === "t")?.[1]);
  const candidates = parts.filter(([key]) => key === "v1").map(([, value]) => value);
  if (!Number.isSafeInteger(timestamp) || candidates.length === 0) {
    return { valid: false, reason: "malformed signature header" };
  }
  if (Math.abs(now - timestamp) > toleranceSeconds) {
    return { valid: false, reason: "timestamp outside tolerance" };
  }
  const expected = Buffer.from(hmac(secret, timestamp, body), "hex");
  const matches = candidates.some((candidate) => {
    const actual = Buffer.from(candidate ?? "", "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
  return matches ? { valid: true } : { valid: false, reason: "signature mismatch" };
}

/** Exponential backoff with jitter: `base * 2^(attempt-1)`, capped, spread by ±`jitter`. */
export function computeBackoffMs(attempt, { baseMs = 5000, maxMs = 3_600_000, jitter = 0.2, random = Math.random } = {}) {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const spread = exponential * jitter * (random() * 2 - 1);
  return Math.max(0, Math.round(exponential + spread));
}

/** The JSON a receiver gets; stored verbatim so every retry sends identical bytes. */
export function buildDeliveryBody(subscriptionId, event) {
  return JSON.stringify({
    id: event.eventId,
    type: event.topic,
    subscription: subscriptionId,
    ledger: event.ledger,
    transactionHash: event.transactionHash,
    occurredAt: event.occurredAt,
    data: event.payload,
  });
}

/**
 * Pushes newly indexed protocol events to subscribers.
 *
 * It is an outbox: each tick (1) copies events past a per-subscription cursor
 * into `webhook_deliveries`, atomically with moving the cursor, then (2) sends
 * whatever is due. A crash between the two loses nothing, and the unique
 * (subscription, event) key makes a rebuild or replay incapable of re-sending.
 * Only final events are ever in the store, so nothing pushed can be reorged away.
 */
export function createWebhookDispatcher({
  store,
  subscriptions,
  metrics,
  fetchImpl = fetch,
  now = () => Date.now(),
  random = Math.random,
  maxAttempts = 8,
  backoffBaseMs = 5000,
  backoffMaxMs = 3_600_000,
  timeoutMs = 10_000,
  batchSize = 200,
  logger = console,
} = {}) {
  const bySubscription = new Map(subscriptions.map((subscription) => [subscription.id, subscription]));
  let timer = null;
  let ticking = false;

  async function enqueueNew(subscription) {
    const cursorKey = `webhook_cursor:${subscription.id}`;
    let cursor = await store.getState(cursorKey);
    if (cursor === null) {
      // A new subscription starts at "now"; it is not sent the whole history.
      await store.setState(cursorKey, await store.getLatestAccordEventId());
      return 0;
    }
    cursor = Number(cursor);

    let enqueued = 0;
    for (;;) {
      const events = await store.getAccordEventsAfter(cursor, batchSize);
      if (events.length === 0) return enqueued;
      const matching = subscription.topics
        ? events.filter((event) => subscription.topics.includes(event.topic))
        : events;
      cursor = events[events.length - 1].id;
      enqueued += await store.enqueueWebhookDeliveries({
        subscriptionId: subscription.id,
        deliveries: matching.map((event) => ({
          eventId: event.eventId,
          body: buildDeliveryBody(subscription.id, event),
        })),
        cursor,
        now: new Date(now()).toISOString(),
      });
      if (events.length < batchSize) return enqueued;
    }
  }

  async function attempt(delivery) {
    const subscription = bySubscription.get(delivery.subscriptionId);
    const nowIso = new Date(now()).toISOString();
    const attempts = delivery.attempts + 1;

    if (!subscription) {
      await store.completeWebhookDelivery({
        id: delivery.id, outcome: "dead", attempts, error: "subscription is no longer configured", now: nowIso,
      });
      metrics?.webhookDeliveries.inc({ subscription: delivery.subscriptionId, result: "dead" });
      return "dead";
    }

    const startedAt = performance.now();
    let statusCode = null;
    let error = null;
    try {
      const response = await fetchImpl(subscription.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "accord-indexer-webhooks/1",
          [SIGNATURE_HEADER]: signPayload({
            secret: subscription.secret,
            body: delivery.body,
            timestamp: Math.floor(now() / 1000),
          }),
          "x-accord-event-id": delivery.eventId,
          "x-accord-delivery-id": String(delivery.id),
          "x-accord-delivery-attempt": String(attempts),
        },
        body: delivery.body,
        // A redirect would re-send the signed body to a host the operator never configured.
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      statusCode = response.status;
      await response.body?.cancel().catch(() => {});
      if (statusCode < 200 || statusCode >= 300) error = `receiver responded with HTTP ${statusCode}`;
    } catch (cause) {
      error = cause?.name === "TimeoutError" ? `timed out after ${timeoutMs}ms` : String(cause?.message ?? cause);
    }
    metrics?.webhookDeliveryDuration.observe(
      { subscription: subscription.id },
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
    await store.completeWebhookDelivery({
      id: delivery.id, outcome, attempts, nextAttemptAt, statusCode, error: error?.slice(0, 500), now: completedAt,
    });
    metrics?.webhookDeliveries.inc({ subscription: subscription.id, result: outcome });
    if (outcome === "dead") {
      logger.error(`[webhooks] ${subscription.id}: delivery ${delivery.id} moved to the dead-letter queue: ${error}`);
    }
    return outcome;
  }

  async function deliverDue() {
    const due = await store.claimDueWebhookDeliveries({ now: new Date(now()).toISOString(), limit: batchSize });
    // Subscriptions deliver in parallel; within one, events go out in order.
    const groups = new Map();
    for (const delivery of due) {
      if (!groups.has(delivery.subscriptionId)) groups.set(delivery.subscriptionId, []);
      groups.get(delivery.subscriptionId).push(delivery);
    }
    const tally = { delivered: 0, retry: 0, dead: 0 };
    await Promise.all([...groups.values()].map(async (group) => {
      for (const delivery of group) tally[await attempt(delivery)] += 1;
    }));
    return tally;
  }

  async function tick() {
    if (ticking) return null;
    ticking = true;
    try {
      let enqueued = 0;
      for (const subscription of subscriptions) enqueued += await enqueueNew(subscription);
      const tally = await deliverDue();
      if (metrics) {
        const counts = await store.countWebhookDeliveries();
        for (const [status, count] of Object.entries(counts)) metrics.webhookBacklog.set({ status }, count);
      }
      return { enqueued, ...tally };
    } catch (error) {
      metrics?.errors.inc({ stage: "webhook" });
      logger.error("Webhook dispatch failed:", error);
      return null;
    } finally {
      ticking = false;
    }
  }

  return {
    tick,
    start(intervalMs = 2000) {
      if (subscriptions.length === 0 || timer) return;
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
