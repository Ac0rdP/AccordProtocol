/**
 * Validates incoming treasury-contract events against the schema registry and
 * quarantines what does not fit instead of dropping it or letting it wedge ingestion.
 *
 * An event from the treasury contract ends up in exactly one place:
 *
 *   accepted     decoded, known topic + version, payload matches its schema -> `accord_events`
 *   quarantined  anything else that the contract emitted                      -> `quarantined_events`
 *   ignored      not from the treasury contract, or carries no topic
 *
 * Quarantine keeps the raw event (topic and value as XDR) so it can be
 * re-validated later, e.g. after the registry learns a new schema version.
 * Everything here is keyed by the event's chain-position dedupe key, so
 * replaying any range quarantines each event at most once.
 */
import { eventDedupeKey, parseAccordEvent } from "./events.js";
import { scValToNative, xdr } from "@stellar/stellar-sdk";
import { defaultRegistry, UNVERSIONED, validatePayload, versionLabel } from "./schema-registry.js";

export const QUARANTINE_REASONS = ["unknown_topic", "unknown_version", "invalid_payload", "undecodable"];
export const VALIDATION_MODES = ["off", "warn", "enforce"];

const MAX_ERRORS = 20;

function decode(encoded) {
  const value = typeof encoded === "string" ? xdr.ScVal.fromXDR(encoded, "base64") : encoded;
  return scValToNative(value);
}

function toBase64(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value.toXDR === "function") return value.toXDR("base64");
  return null;
}

/** The raw event as plain JSON: enough to rebuild and re-validate it later. */
export function serializeRawEvent(event) {
  return {
    id: event.id ?? null,
    pagingToken: event.pagingToken ?? null,
    contractId: event.contractId ?? null,
    ledger: Number(event.ledger),
    ledgerClosedAt: event.ledgerClosedAt ?? null,
    txHash: event.txHash ?? null,
    ...(event.eventIndex !== undefined ? { eventIndex: event.eventIndex } : {}),
    ...(event.index !== undefined ? { index: event.index } : {}),
    topic: Array.isArray(event.topic) ? event.topic.map(toBase64) : [],
    value: toBase64(event.value),
  };
}

function occurredAtOf(event, now) {
  const time = new Date(event.ledgerClosedAt);
  return Number.isNaN(time.getTime()) ? now : time.toISOString();
}

function quarantineRecord(event, { reason, errors, topic = null, schemaVersion = null, now }) {
  // The schema version is only a column value when it is a plain safe integer.
  const safeVersion = Number.isSafeInteger(schemaVersion) && schemaVersion >= 0 ? schemaVersion : null;
  return {
    eventId: String(event.id ?? event.pagingToken ?? `${Number(event.ledger)}:${event.txHash ?? "unknown"}`),
    dedupeKey: eventDedupeKey(event),
    contractId: event.contractId ? String(event.contractId) : null,
    topic,
    schemaVersion: safeVersion,
    reason,
    errors: errors.slice(0, MAX_ERRORS),
    raw: serializeRawEvent(event),
    ledger: Number(event.ledger),
    transactionHash: event.txHash ?? null,
    occurredAt: occurredAtOf(event, now),
    now,
  };
}

/**
 * @param {object} [options]
 * @param {object} [options.registry]
 * @param {"off"|"warn"|"enforce"} [options.mode]  off: legacy behaviour (unknown topics dropped, payloads unchecked);
 *   warn: invalid payloads are indexed anyway but reported; enforce: invalid payloads are quarantined
 * @param {boolean} [options.strict]  treat fields outside the schema as violations
 * @param {boolean} [options.allowUnversioned]  accept events from pre-versioning deployments
 */
export function createEventValidator({
  registry = defaultRegistry,
  mode = "enforce",
  strict = true,
  allowUnversioned = true,
} = {}) {
  const isKnownTopic = (topic) => registry.hasTopic(topic);
  if (!VALIDATION_MODES.includes(mode)) throw new Error(`validation mode must be one of: ${VALIDATION_MODES.join(", ")}`);

  /**
   * Decides what to do with one raw event.
   *
   * @returns {{outcome: "ignore"}
   *   | {outcome: "accept", entry: object, warnings: string[]}
   *   | {outcome: "quarantine", record: object}}
   */
  function classify(event, treasuryAddress, target, { now = new Date().toISOString() } = {}) {
    if (mode === "off") {
      const entry = parseAccordEvent(event, treasuryAddress, target);
      return entry ? { outcome: "accept", entry, warnings: [] } : { outcome: "ignore" };
    }

    const contractId = String(event.contractId ?? "").toLowerCase();
    if (contractId !== treasuryAddress.toLowerCase()) return { outcome: "ignore" };
    if (!Array.isArray(event.topic) || event.topic.length === 0) return { outcome: "ignore" };

    const quarantine = (details) => ({ outcome: "quarantine", record: quarantineRecord(event, { ...details, now }) });

    let topic;
    let payload;
    try {
      topic = decode(event.topic[0]);
      payload = decode(event.value);
    } catch (error) {
      return quarantine({ reason: "undecodable", errors: [`could not decode the event: ${String(error?.message ?? error)}`] });
    }
    if (typeof topic !== "string") {
      return quarantine({ reason: "undecodable", errors: [`the first topic must be a symbol, got ${typeof topic}`] });
    }
    if (!registry.hasTopic(topic)) {
      return quarantine({ reason: "unknown_topic", topic, errors: [`no schema is registered for topic "${topic}"`] });
    }

    const rawVersion = payload !== null && typeof payload === "object" ? payload.version : undefined;
    let version = UNVERSIONED;
    if (rawVersion !== undefined && rawVersion !== null) {
      const parsed = Number(rawVersion);
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        return quarantine({ reason: "invalid_payload", topic, errors: [`version: expected a positive integer, got ${String(rawVersion)}`] });
      }
      version = parsed;
    }
    if (version === UNVERSIONED && !allowUnversioned) {
      return quarantine({ reason: "unknown_version", topic, errors: ["unversioned events are not accepted (EVENT_ALLOW_UNVERSIONED=false)"] });
    }

    const schema = registry.get(topic, version);
    if (!schema) {
      const known = registry.versions(topic).map(versionLabel).join(", ");
      return quarantine({
        reason: "unknown_version",
        topic,
        schemaVersion: version,
        errors: [`no schema for "${topic}" at version ${versionLabel(version)} (registered: ${known})`],
      });
    }

    const errors = validatePayload(schema, payload, { types: registry.types, strict });
    if (errors.length > 0 && mode === "enforce") {
      return quarantine({ reason: "invalid_payload", topic, schemaVersion: version, errors });
    }

    const entry = parseAccordEvent(event, treasuryAddress, target, { isKnownTopic });
    if (!entry) return { outcome: "ignore" };
    return { outcome: "accept", entry, warnings: errors };
  }

  return { mode, strict, allowUnversioned, registry, classify };
}

export const defaultValidator = createEventValidator();

/**
 * Classifies one event and applies the outcome to the store. Safe to repeat for
 * the same event: the store dedupes both accepted and quarantined events.
 *
 * @returns {Promise<{entry: object|null, recorded: boolean, quarantined: string|null,
 *   newlyQuarantined: boolean, warnings: string[]}>}
 */
export async function ingestAccordEvent({ event, treasuryAddress, store, validator = defaultValidator, target, now }) {
  const result = validator.classify(event, treasuryAddress, target, now ? { now } : undefined);

  if (result.outcome === "ignore") {
    return { entry: null, recorded: false, quarantined: null, newlyQuarantined: false, warnings: [] };
  }

  if (result.outcome === "quarantine") {
    const newlyQuarantined = await store.quarantineEvent(result.record);
    return {
      entry: null,
      recorded: false,
      quarantined: result.record.reason,
      newlyQuarantined,
      quarantineErrors: result.record.errors,
      warnings: [],
    };
  }

  const recorded = await store.recordAccordEvent(result.entry);
  // An event that was quarantined earlier and is valid now is no longer stuck.
  await store.resolveQuarantinedEvent?.({ dedupeKey: result.entry.dedupeKey, status: "released", now: now ?? new Date().toISOString() });
  return { entry: result.entry, recorded, quarantined: null, newlyQuarantined: false, warnings: result.warnings };
}

/**
 * Re-validates quarantined events from their stored raw form, releasing every
 * one that is valid now (for example after the registry gained a schema).
 * Safe to run repeatedly and from any point: released events are deduped on
 * insert and a still-invalid one just stays quarantined.
 *
 * @returns {Promise<{examined: number, released: number, stillQuarantined: number}>}
 */
export async function reprocessQuarantine({
  store,
  treasuryAddress,
  validator = defaultValidator,
  reason,
  topic,
  batchSize = 200,
  now = () => new Date().toISOString(),
  onReleased = null,
}) {
  let examined = 0;
  let released = 0;
  let stillQuarantined = 0;
  let afterId = 0;

  for (;;) {
    const batch = await store.listQuarantinedEvents({
      status: "quarantined", reason, topic, afterId, order: "asc", limit: batchSize, offset: 0, includeRaw: true,
    });
    if (batch.length === 0) break;

    for (const row of batch) {
      examined += 1;
      afterId = row.id;
      const result = validator.classify(row.raw, treasuryAddress, undefined, { now: now() });
      if (result.outcome !== "accept") {
        stillQuarantined += 1;
        continue;
      }
      await store.recordAccordEvent(result.entry);
      await store.resolveQuarantinedEvent({ id: row.id, status: "released", now: now() });
      released += 1;
      onReleased?.(result.entry);
    }
    if (batch.length < batchSize) break;
  }

  return { examined, released, stillQuarantined };
}
