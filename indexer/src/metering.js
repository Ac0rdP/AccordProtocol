/**
 * Usage metering and billing event hooks.
 *
 *   record   writes one usage record keyed by a deterministic `eventId`; recording the
 *            same id again is a no-op, so a webhook redelivery or a replay from any
 *            checkpoint never counts twice
 *   flush    hands pending records to the billing hooks at-least-once: a failing hook
 *            leaves the record pending with a backoff, and after `maxAttempts` it is
 *            dead-lettered (and can be requeued). Progress lives in the store, so a
 *            crash or restart resumes exactly where it stopped.
 *   summary  usage per kind and subject for a period
 *
 * Kinds: `api_call` (analytics reads), `report` (computed reports such as /runway)
 * and `webhook` (a delivered webhook). Metering is off unless USAGE_METERING_ENABLED.
 * Hooks receive `{ id, kind, subject, quantity, occurredAt, metadata }`, where `id`
 * is the idempotency key a billing system should dedupe on.
 */
import { signPayload, SIGNATURE_HEADER, computeBackoffMs } from "./webhooks.js";

export const USAGE_KINDS = ["api_call", "report", "webhook"];

/** A hook that POSTs a signed JSON billing event to `url`; non-2xx counts as a failure. */
export function createHttpBillingHook({ url, secret, fetchImpl = fetch, timeoutMs = 10_000, now = () => Date.now() }) {
  return async (event) => {
    const body = JSON.stringify(event);
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "accord-indexer-billing/1",
        "x-accord-usage-id": event.id,
        [SIGNATURE_HEADER]: signPayload({ secret, body, timestamp: Math.floor(now() / 1000) }),
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel().catch(() => {});
    if (response.status < 200 || response.status >= 300) throw new Error(`billing hook responded with HTTP ${response.status}`);
  };
}

export function createMeteringService({
  store,
  config,
  hooks = [],
  metrics = null,
  now = () => Date.now(),
  random = Math.random,
  logger = console,
}) {
  const iso = (ms) => new Date(ms).toISOString();
  const enabled = Boolean(config.enabled);

  /** @returns {Promise<boolean>} true when a new record was written */
  async function record({ eventId, kind, subject = "anonymous", quantity = 1, occurredAt, metadata = {} }) {
    if (!enabled) return false;
    if (!USAGE_KINDS.includes(kind)) throw new Error(`usage kind must be one of: ${USAGE_KINDS.join(", ")}`);
    if (typeof eventId !== "string" || eventId === "") throw new Error("usage eventId must be a non-empty string");
    if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error("usage quantity must be a positive integer");
    const inserted = await store.recordUsageEvent({
      eventId, kind, subject, quantity, metadata,
      occurredAt: occurredAt ?? iso(now()),
      now: iso(now()),
    });
    metrics?.usageEvents?.inc({ kind, result: inserted ? "recorded" : "duplicate" });
    return inserted;
  }

  /** Like `record`, but a metering failure is logged and never reaches the caller's request. */
  async function recordSafely(usage) {
    try {
      return await record(usage);
    } catch (error) {
      metrics?.errors?.inc({ stage: "metering" });
      logger.error("[metering] could not record usage:", error.message);
      return false;
    }
  }

  async function emit(usage) {
    const attempts = usage.attempts + 1;
    const payload = {
      id: usage.eventId,
      kind: usage.kind,
      subject: usage.subject,
      quantity: usage.quantity,
      occurredAt: usage.occurredAt,
      metadata: usage.metadata,
    };
    let error = null;
    for (const hook of hooks) {
      try {
        await hook(payload);
      } catch (cause) {
        error = String(cause?.message ?? cause).slice(0, 500);
        break;
      }
    }
    const time = now();
    if (!error) {
      await store.completeUsageEvent({ id: usage.id, outcome: "emitted", attempts, now: iso(time) });
      return "emitted";
    }
    if (attempts >= config.maxAttempts) {
      await store.completeUsageEvent({ id: usage.id, outcome: "dead", attempts, error, now: iso(time) });
      logger.error(`[metering] usage ${usage.eventId} moved to the dead-letter queue: ${error}`);
      return "dead";
    }
    const nextAttemptAt = iso(time + computeBackoffMs(attempts, { baseMs: config.backoffBaseMs, random }));
    await store.completeUsageEvent({ id: usage.id, outcome: "retry", attempts, nextAttemptAt, error, now: iso(time) });
    return "retry";
  }

  /** One pass over the due records. Usage stays pending until a hook has accepted it. */
  async function flush() {
    const tally = { emitted: 0, retry: 0, dead: 0 };
    if (!enabled || hooks.length === 0) return tally;
    const due = await store.claimDueUsageEvents({ now: iso(now()), limit: config.batchSize });
    for (const usage of due) {
      const outcome = await emit(usage);
      tally[outcome] += 1;
      metrics?.usageEvents?.inc({ kind: usage.kind, result: outcome });
    }
    return tally;
  }

  let timer = null;
  let flushing = false;
  async function tick() {
    if (flushing) return null;
    flushing = true;
    try {
      return await flush();
    } catch (error) {
      metrics?.errors?.inc({ stage: "metering" });
      logger.error("[metering] billing hook dispatch failed:", error);
      return null;
    } finally {
      flushing = false;
    }
  }

  return {
    enabled,
    record,
    recordSafely,
    flush,
    tick,
    summary: (query) => store.summarizeUsage(query),
    counts: () => store.countUsageEvents(),
    requeueDead: () => store.requeueDeadUsageEvents({ now: iso(now()) }),
    start(intervalMs = 5000) {
      if (!enabled || hooks.length === 0 || timer) return;
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
