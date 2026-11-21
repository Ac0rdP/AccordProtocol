import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createApi } from "../src/api.js";
import { eventCatalog } from "../src/catalog.js";
import { EVENT_VALIDATION_MODES, loadIndexerConfig, resolveEventValidationConfig } from "../src/config.js";
import {
  createEventValidator,
  ingestAccordEvent,
  QUARANTINE_REASONS,
  reprocessQuarantine,
  serializeRawEvent,
} from "../src/event-validation.js";
import { createReadiness } from "../src/health.js";
import { indexEventBatch } from "../src/indexing.js";
import { createIndexerMetrics, recordBatchSuccess } from "../src/metrics.js";
import {
  createSchemaRegistry,
  CURRENT_EVENT_SCHEMA_VERSION,
  UNVERSIONED,
  validatePayload,
} from "../src/schema-registry.js";
import { loadMigrations } from "../src/store/migrations.js";
import { cleanupTempStores, createMockRpc, createStore, describeEachBackend, encoded, sender, tokenAddress, treasury } from "./helpers.js";

afterEach(cleanupTempStores);

const NOW = "2026-10-01T00:00:00.000Z";
const LATER = "2026-10-02T00:00:00.000Z";

let sequence = 0;
/** A raw contract event as the RPC returns it, with a unique chain position per call. */
function accordEvent({ topic = "migrated", payload, ledger = 10, contractId = treasury, id, txHash } = {}) {
  sequence += 1;
  const eventId = id ?? `${String(ledger).padStart(19, "0")}-${String(sequence).padStart(10, "0")}`;
  return {
    id: eventId,
    pagingToken: eventId,
    contractId,
    ledger,
    ledgerClosedAt: "2026-09-27T12:00:00Z",
    txHash: txHash ?? `tx-${eventId}`,
    topic: [encoded(topic, "symbol")],
    value: encoded(payload ?? { owner_count: 2, total_weight: 2, version: CURRENT_EVENT_SCHEMA_VERSION }, undefined),
  };
}

const executedV2 = { id: 1, executor: sender, version: 2 };
const executedV1 = { id: 1, executor: sender, transfers: [{ to: sender, token: tokenAddress, amount: 5 }], version: 1 };
const classify = (event, validator = createEventValidator()) => validator.classify(event, treasury, undefined, { now: NOW });

describe("schema registry", () => {
  const registry = createSchemaRegistry();

  it("covers every catalogued topic at every version, plus unversioned", () => {
    assert.deepEqual([...registry.topics()].sort(), Object.keys(eventCatalog).sort());
    for (const topic of registry.topics()) {
      assert.deepEqual(registry.versions(topic), [1, 2, UNVERSIONED]);
      assert.equal(registry.get(topic, CURRENT_EVENT_SCHEMA_VERSION).fields.version, "u32");
    }
  });

  it("derives older versions from the recorded changes", () => {
    assert.equal("transfers" in registry.get("executed", 2).fields, false);
    assert.equal(registry.get("executed", 1).fields.transfers, "Vec<Transfer>");
    // Other events are identical across versions 1 and 2.
    assert.deepEqual(registry.get("approved", 1).fields, registry.get("approved", 2).fields);
  });

  it("models pre-versioning events as version 1 without the version marker", () => {
    const unversioned = registry.get("executed", UNVERSIONED);
    assert.equal("version" in unversioned.fields, false);
    assert.equal(unversioned.fields.transfers, "Vec<Transfer>");
  });

  it("returns null for unknown topics and versions and describes itself for the API", () => {
    assert.equal(registry.get("nope", 2), null);
    assert.equal(registry.get("executed", 3), null);
    assert.equal(registry.hasTopic("nope"), false);
    const executed = registry.describe().find(({ topic }) => topic === "executed");
    assert.deepEqual(executed.versions.map(({ version }) => version), ["unversioned", "1", "2"]);
    assert.deepEqual(executed.versions.map(({ current }) => current), [false, false, true]);
  });

  it("accepts new schemas and refuses malformed registrations", () => {
    const custom = createSchemaRegistry();
    custom.register({ topic: "executed", version: 3, fields: { id: "u64", version: "u32" } });
    assert.deepEqual(custom.get("executed", 3).fields, { id: "u64", version: "u32" });
    assert.throws(() => custom.register({ topic: "", version: 3, fields: {} }), /topic/);
    assert.throws(() => custom.register({ topic: "x", version: 0, fields: {} }), /version/);
    assert.throws(() => custom.register({ topic: "x", version: 1 }), /fields/);
  });
});

describe("payload validation", () => {
  const registry = createSchemaRegistry();
  const check = (topic, version, payload, options) => validatePayload(registry.get(topic, version), payload, options);

  it("accepts a conforming payload", () => {
    assert.deepEqual(check("executed", 2, executedV2), []);
    assert.deepEqual(check("executed", 1, executedV1), []);
  });

  it("accepts integers however they were decoded", () => {
    assert.deepEqual(check("executed", 2, { ...executedV2, id: 7n }), []);
    assert.deepEqual(check("executed", 2, { ...executedV2, id: "7" }), []);
  });

  it("reports missing, mistyped and out-of-range fields", () => {
    const { executor: _executor, ...missing } = executedV2;
    assert.deepEqual(check("executed", 2, missing), ["executor: missing value"]);
    assert.match(check("executed", 2, { ...executedV2, id: "seven" })[0], /id: expected u64/);
    assert.match(check("executed", 2, { ...executedV2, id: -1 })[0], /out of range for u64/);
    assert.match(check("migrated", 2, { owner_count: 2 ** 32, total_weight: 1, version: 2 })[0], /out of range for u32/);
    assert.match(check("executed", 2, { ...executedV2, executor: "not-an-address" })[0], /expected a Stellar address/);
    assert.match(check("executed", 2, { ...executedV2, executor: 5 })[0], /expected a Stellar address/);
  });

  it("checks nested transfers and collects every problem", () => {
    const errors = check("executed", 1, { ...executedV1, transfers: [{ to: sender, token: "bad", amount: "x" }, 7] });
    assert.ok(errors.some((error) => error.startsWith("transfers[0].token")));
    assert.ok(errors.some((error) => error.startsWith("transfers[0].amount")));
    assert.ok(errors.some((error) => error.startsWith("transfers[1]: expected an object")));
    assert.match(check("executed", 1, { ...executedV1, transfers: "nope" })[0], /expected Vec<Transfer>/);
  });

  it("treats fields outside the schema as violations only when strict", () => {
    const withExtra = { ...executedV2, surprise: true };
    assert.deepEqual(check("executed", 2, withExtra), ["surprise: unexpected field"]);
    assert.deepEqual(check("executed", 2, withExtra, { strict: false }), []);
  });

  it("rejects a payload that is not an object", () => {
    for (const payload of [null, 5, "x", [executedV2]]) {
      assert.match(check("executed", 2, payload)[0], /expected an object/);
    }
  });

  it("handles Option and bytes types", () => {
    const limit = (value) => check("s_lim", 2, { owner: sender, token: tokenAddress, previous_limit: value, new_limit: 5, version: 2 });
    assert.deepEqual(limit(null), []);
    assert.deepEqual(limit(10), []);
    assert.match(limit("x")[0], /previous_limit: expected i128/);
    const upgraded = (hash) => check("upgraded", 2, { caller: sender, new_wasm_hash: hash, version: 2 });
    assert.deepEqual(upgraded(Buffer.alloc(32)), []);
    assert.match(upgraded(Buffer.alloc(5))[0], /expected BytesN<32>/);
  });
});

describe("event classification", () => {
  it("accepts a valid current-version event and keeps the stored shape", () => {
    const result = classify(accordEvent({ topic: "executed", payload: executedV2 }));
    assert.equal(result.outcome, "accept");
    assert.equal(result.entry.topic, "executed");
    assert.equal(result.entry.schemaVersion, 2);
    assert.deepEqual(result.warnings, []);
  });

  it("stays compatible with the previous schema version and with unversioned events", () => {
    const v1 = classify(accordEvent({ topic: "executed", payload: executedV1 }));
    assert.equal(v1.outcome, "accept");
    assert.equal(v1.entry.schemaVersion, 1);

    const { version: _version, ...legacy } = executedV1;
    const unversioned = classify(accordEvent({ topic: "executed", payload: legacy }));
    assert.equal(unversioned.outcome, "accept");
    assert.equal(unversioned.entry.schemaVersion, null);
  });

  it("does not accept v2 fields on a v1 event or v1 fields on a v2 event", () => {
    assert.equal(classify(accordEvent({ topic: "executed", payload: { ...executedV2, version: 1 } })).record.reason, "invalid_payload");
    assert.equal(classify(accordEvent({ topic: "executed", payload: { ...executedV1, version: 2 } })).record.reason, "invalid_payload");
  });

  it("quarantines an unknown topic with the raw event kept for later", () => {
    const event = accordEvent({ topic: "brand_new", payload: { a: 1, version: 2 } });
    const { outcome, record } = classify(event);
    assert.equal(outcome, "quarantine");
    assert.equal(record.reason, "unknown_topic");
    assert.equal(record.topic, "brand_new");
    assert.equal(record.dedupeKey, `10:${event.txHash}:${Number(event.id.split("-")[1])}`);
    assert.equal(record.raw.contractId, treasury);
    assert.equal(record.raw.topic.length, 1);
    assert.match(record.raw.value, /^[A-Za-z0-9+/=]+$/);
  });

  it("quarantines a schema version it has never heard of", () => {
    const { record } = classify(accordEvent({ topic: "executed", payload: { ...executedV2, version: 3 } }));
    assert.equal(record.reason, "unknown_version");
    assert.equal(record.schemaVersion, 3);
    assert.match(record.errors[0], /registered: unversioned, 1, 2|registered: 1, 2, unversioned/);
  });

  it("quarantines malformed payloads with every violation listed", () => {
    const { record } = classify(accordEvent({ topic: "executed", payload: { id: "x", version: 2 } }));
    assert.equal(record.reason, "invalid_payload");
    assert.equal(record.topic, "executed");
    assert.equal(record.errors.length, 2);
  });

  it("quarantines a bad version marker instead of guessing", () => {
    for (const version of [0, -1, "abc"]) {
      const { outcome, record } = classify(accordEvent({ topic: "executed", payload: { ...executedV2, version } }));
      assert.equal(outcome, "quarantine", `version ${version}`);
      assert.equal(record.reason, "invalid_payload");
    }
  });

  it("quarantines an event it cannot decode instead of throwing", () => {
    const event = accordEvent({ topic: "executed", payload: executedV2 });
    const garbage = { ...event, value: {} };
    const result = classify(garbage);
    assert.equal(result.outcome, "quarantine");
    assert.equal(result.record.reason, "undecodable");

    const notASymbol = { ...event, topic: [encoded(5, "u32")] };
    assert.equal(classify(notASymbol).record.reason, "undecodable");
  });

  it("ignores events that are not the treasury's or have no topic", () => {
    assert.equal(classify(accordEvent({ contractId: tokenAddress })).outcome, "ignore");
    assert.equal(classify({ ...accordEvent(), topic: [] }).outcome, "ignore");
    assert.equal(classify({ ...accordEvent(), topic: undefined }).outcome, "ignore");
  });

  it("can refuse unversioned events", () => {
    const { version: _version, ...legacy } = executedV1;
    const strictVersions = createEventValidator({ allowUnversioned: false });
    assert.equal(classify(accordEvent({ topic: "executed", payload: legacy }), strictVersions).record.reason, "unknown_version");
  });

  it("tolerates unexpected fields when not strict", () => {
    const event = accordEvent({ topic: "executed", payload: { ...executedV2, extra: 1 } });
    assert.equal(classify(event).outcome, "quarantine");
    assert.equal(classify(event, createEventValidator({ strict: false })).outcome, "accept");
  });

  it("warn mode indexes an invalid payload but reports it; unknown topics are still quarantined", () => {
    const warn = createEventValidator({ mode: "warn" });
    const invalid = classify(accordEvent({ topic: "executed", payload: { id: "x", version: 2 } }), warn);
    assert.equal(invalid.outcome, "accept");
    assert.equal(invalid.warnings.length, 2);
    assert.equal(classify(accordEvent({ topic: "brand_new", payload: { version: 2 } }), warn).outcome, "quarantine");
  });

  it("off mode keeps the previous behaviour: no validation, unknown topics ignored", () => {
    const off = createEventValidator({ mode: "off" });
    assert.equal(classify(accordEvent({ topic: "executed", payload: { id: "x", version: 2 } }), off).outcome, "accept");
    assert.equal(classify(accordEvent({ topic: "brand_new", payload: { version: 2 } }), off).outcome, "ignore");
  });

  it("rejects an unknown validation mode", () => {
    assert.throws(() => createEventValidator({ mode: "loud" }), /validation mode/);
  });
});

describeEachBackend("quarantine store", () => {
  const record = (overrides = {}) => classify(accordEvent({ topic: "brand_new", payload: { version: 2 }, ...overrides })).record;

  it("keeps each event once however often it is quarantined", async () => {
    const store = await createStore();
    const first = record();
    assert.equal(await store.quarantineEvent(first), true);
    assert.equal(await store.quarantineEvent(first), false);
    assert.equal(await store.quarantineEvent({ ...first, eventId: "renamed", reason: "invalid_payload" }), false);
    const [row] = await store.listQuarantinedEvents({ limit: 10, offset: 0 });
    assert.equal(row.reason, "unknown_topic", "the first verdict stands");
    assert.equal((await store.listQuarantinedEvents({ limit: 10, offset: 0 })).length, 1);
  });

  it("round-trips the details and hides the raw event unless asked", async () => {
    const store = await createStore();
    const stored = record();
    await store.quarantineEvent(stored);
    const [plain] = await store.listQuarantinedEvents({ limit: 10, offset: 0 });
    assert.equal("raw" in plain, false);
    assert.deepEqual(plain.errors, stored.errors);
    assert.equal(plain.status, "quarantined");
    assert.equal(plain.topic, "brand_new");
    assert.equal(plain.ledger, 10);
    assert.equal(plain.occurredAt, "2026-09-27T12:00:00.000Z");
    const [withRaw] = await store.listQuarantinedEvents({ limit: 10, offset: 0, includeRaw: true });
    assert.deepEqual(withRaw.raw, stored.raw);
  });

  it("filters, orders and counts", async () => {
    const store = await createStore();
    await store.quarantineEvent(record());
    await store.quarantineEvent(classify(accordEvent({ topic: "executed", payload: { ...executedV2, version: 3 } })).record);
    await store.quarantineEvent(classify(accordEvent({ topic: "executed", payload: { id: "x", version: 2 } })).record);

    const reasons = (rows) => rows.map(({ reason }) => reason);
    assert.deepEqual(reasons(await store.listQuarantinedEvents({ limit: 10, offset: 0 })), ["invalid_payload", "unknown_version", "unknown_topic"]);
    assert.deepEqual(reasons(await store.listQuarantinedEvents({ limit: 10, offset: 0, order: "asc" })), ["unknown_topic", "unknown_version", "invalid_payload"]);
    assert.deepEqual(reasons(await store.listQuarantinedEvents({ reason: "unknown_version", limit: 10, offset: 0 })), ["unknown_version"]);
    assert.equal((await store.listQuarantinedEvents({ topic: "executed", limit: 10, offset: 0 })).length, 2);
    assert.equal((await store.listQuarantinedEvents({ afterId: 1, limit: 10, offset: 0 })).length, 2);
    assert.deepEqual(await store.countQuarantinedEvents(), {
      quarantined: 3, released: 0, discarded: 0, byReason: { unknown_topic: 1, unknown_version: 1, invalid_payload: 1 },
    });
  });

  it("resolves an event once and never reopens it", async () => {
    const store = await createStore();
    const stored = record();
    await store.quarantineEvent(stored);
    const [row] = await store.listQuarantinedEvents({ limit: 10, offset: 0 });

    assert.equal(await store.resolveQuarantinedEvent({ id: row.id, status: "discarded", now: LATER }), true);
    assert.equal(await store.resolveQuarantinedEvent({ id: row.id, status: "released", now: LATER }), false);
    assert.equal(await store.resolveQuarantinedEvent({ dedupeKey: stored.dedupeKey, status: "released", now: LATER }), false);
    const [after] = await store.listQuarantinedEvents({ limit: 10, offset: 0 });
    assert.equal(after.status, "discarded");
    assert.equal(after.resolvedAt, LATER);
    // Re-quarantining a resolved event does not bring it back.
    assert.equal(await store.quarantineEvent(stored), false);
    await assert.rejects(store.resolveQuarantinedEvent({ id: row.id, status: "bogus" }), /released or discarded/);
  });

  it("drops quarantined events above a rewind and on a full clear", async () => {
    const store = await createStore();
    await store.quarantineEvent(classify(accordEvent({ topic: "x1", ledger: 10, payload: { version: 2 } })).record);
    await store.quarantineEvent(classify(accordEvent({ topic: "x2", ledger: 20, payload: { version: 2 } })).record);
    await store.rewindToLedger(15);
    assert.deepEqual((await store.listQuarantinedEvents({ limit: 10, offset: 0 })).map(({ topic }) => topic), ["x1"]);
    await store.clearHistory();
    assert.equal((await store.listQuarantinedEvents({ limit: 10, offset: 0 })).length, 0);
  });
});

describeEachBackend("event ingestion with validation", () => {
  const tokens = [{ name: "USDC", address: tokenAddress }];
  const batch = (store, rpc, options = {}) =>
    indexEventBatch({ stellar: rpc, store, tokens, treasuryAddress: treasury, startLedger: 10, finalityLag: 0, ...options });
  const mixedEvents = () => [
    accordEvent({ topic: "executed", payload: executedV2, ledger: 10 }),
    accordEvent({ topic: "brand_new", payload: { version: 2 }, ledger: 11 }),
    accordEvent({ topic: "executed", payload: { id: "x", version: 2 }, ledger: 12 }),
  ];

  it("indexes the valid event and quarantines the rest, each exactly once", async () => {
    const store = await createStore();
    const rpc = createMockRpc({ events: mixedEvents(), latestLedger: 12 });
    const result = await batch(store, rpc);

    assert.equal(result.indexed, 1);
    assert.equal(result.quarantined, 2);
    assert.deepEqual(result.quarantineReasons, { unknown_topic: 1, invalid_payload: 1 });
    assert.equal((await store.getAccordEvents({ limit: 10, offset: 0 })).length, 1);
    assert.equal((await store.countQuarantinedEvents()).quarantined, 2);
  });

  it("is idempotent when replayed from any checkpoint", async () => {
    const store = await createStore();
    const rpc = createMockRpc({ events: mixedEvents(), latestLedger: 12 });
    await batch(store, rpc);

    for (const checkpoint of ["10", "11", "12"]) {
      await store.setState("next_ledger", checkpoint);
      await store.setState("event_cursor", "");
      const replayed = await batch(store, rpc);
      assert.equal(replayed.indexed, 0, `from ${checkpoint}`);
      assert.equal(replayed.quarantined, 0, `from ${checkpoint}`);
    }
    assert.equal((await store.getAccordEvents({ limit: 10, offset: 0 })).length, 1);
    assert.equal((await store.countQuarantinedEvents()).quarantined, 2);
  });

  it("recovers from a store failure mid-batch without losing or duplicating anything", async () => {
    const store = await createStore();
    const rpc = createMockRpc({ events: mixedEvents(), latestLedger: 12 });
    let fail = true;
    const flaky = {
      ...store,
      quarantineEvent: async (record) => {
        if (fail) {
          fail = false;
          throw new Error("database unavailable");
        }
        return store.quarantineEvent(record);
      },
    };

    await assert.rejects(batch(flaky, rpc), /database unavailable/);
    assert.equal(await store.getState("next_ledger"), null, "the checkpoint did not move past the failure");

    const recovered = await batch(flaky, rpc);
    assert.equal(recovered.indexed, 0, "the valid event was already stored");
    assert.equal(recovered.quarantined, 2);
    assert.equal((await store.getAccordEvents({ limit: 10, offset: 0 })).length, 1);
    assert.equal((await store.countQuarantinedEvents()).quarantined, 2);
    assert.equal(await store.getState("next_ledger"), "13");
  });

  it("an undecodable event no longer wedges the indexer", async () => {
    const store = await createStore();
    const broken = { ...accordEvent({ ledger: 10 }), value: {} };
    const rpc = createMockRpc({ events: [broken, accordEvent({ topic: "executed", payload: executedV2, ledger: 11 })], latestLedger: 11 });
    const result = await batch(store, rpc);
    assert.equal(result.indexed, 1);
    assert.deepEqual(result.quarantineReasons, { undecodable: 1 });
  });

  it("honours the configured mode", async () => {
    const warnStore = await createStore();
    const warn = await batch(warnStore, createMockRpc({ events: mixedEvents(), latestLedger: 12 }), {
      validator: createEventValidator({ mode: "warn" }),
    });
    assert.equal(warn.indexed, 2, "the invalid payload is indexed in warn mode");
    assert.equal(warn.validationWarnings, 1);
    assert.equal(warn.quarantined, 1, "the unknown topic is still quarantined");

    const offStore = await createStore();
    const off = await batch(offStore, createMockRpc({ events: mixedEvents(), latestLedger: 12 }), {
      validator: createEventValidator({ mode: "off" }),
    });
    assert.equal(off.quarantined, 0);
    assert.equal(off.indexed, 2);
  });

  it("releases a quarantined event when the same event is ingested again after it became valid", async () => {
    const store = await createStore();
    const event = accordEvent({ topic: "future", payload: { value: 1, version: 3 }, ledger: 10 });
    const strict = createEventValidator();
    assert.equal((await ingestAccordEvent({ event, treasuryAddress: treasury, store, validator: strict })).quarantined, "unknown_topic");

    const registry = createSchemaRegistry();
    registry.register({ topic: "future", version: 3, fields: { value: "u32", version: "u32" } });
    const upgraded = createEventValidator({ registry });
    const result = await ingestAccordEvent({ event, treasuryAddress: treasury, store, validator: upgraded });
    assert.equal(result.recorded, true);
    assert.equal((await store.countQuarantinedEvents()).released, 1);
    assert.equal((await store.countQuarantinedEvents()).quarantined, 0);
  });
});

describeEachBackend("quarantine reprocessing", () => {
  const future = (ledger) => accordEvent({ topic: "future", payload: { value: 1, version: 3 }, ledger });
  const upgradedValidator = () => {
    const registry = createSchemaRegistry();
    registry.register({ topic: "future", version: 3, fields: { value: "u32", version: "u32" } });
    return createEventValidator({ registry });
  };

  it("releases events that became valid and leaves the rest", async () => {
    const store = await createStore();
    for (const event of [future(10), future(11), accordEvent({ topic: "other", payload: { version: 2 }, ledger: 12 })]) {
      await ingestAccordEvent({ event, treasuryAddress: treasury, store });
    }
    assert.equal((await store.countQuarantinedEvents()).quarantined, 3);

    const released = [];
    const result = await reprocessQuarantine({
      store, treasuryAddress: treasury, validator: upgradedValidator(), now: () => LATER, onReleased: (entry) => released.push(entry.topic),
    });
    assert.deepEqual(result, { examined: 3, released: 2, stillQuarantined: 1 });
    assert.deepEqual(released, ["future", "future"]);
    assert.deepEqual((await store.getAccordEvents({ limit: 10, offset: 0 })).map(({ topic }) => topic), ["future", "future"]);
    const counts = await store.countQuarantinedEvents();
    assert.deepEqual([counts.quarantined, counts.released], [1, 2]);
  });

  it("is safe to run again and from a partial run", async () => {
    const store = await createStore();
    for (const event of [future(10), future(11), future(12)]) await ingestAccordEvent({ event, treasuryAddress: treasury, store });

    const first = await reprocessQuarantine({ store, treasuryAddress: treasury, validator: upgradedValidator(), batchSize: 2 });
    assert.deepEqual(first, { examined: 3, released: 3, stillQuarantined: 0 });
    const again = await reprocessQuarantine({ store, treasuryAddress: treasury, validator: upgradedValidator() });
    assert.deepEqual(again, { examined: 0, released: 0, stillQuarantined: 0 });
    assert.equal((await store.getAccordEvents({ limit: 10, offset: 0 })).length, 3, "no duplicates");
  });

  it("does not release what is still invalid, and can be narrowed by topic or reason", async () => {
    const store = await createStore();
    await ingestAccordEvent({ event: future(10), treasuryAddress: treasury, store });
    await ingestAccordEvent({ event: accordEvent({ topic: "executed", payload: { id: "x", version: 2 }, ledger: 11 }), treasuryAddress: treasury, store });

    const narrowed = await reprocessQuarantine({ store, treasuryAddress: treasury, validator: upgradedValidator(), reason: "invalid_payload" });
    assert.deepEqual(narrowed, { examined: 1, released: 0, stillQuarantined: 1 });
    const byTopic = await reprocessQuarantine({ store, treasuryAddress: treasury, validator: upgradedValidator(), topic: "future" });
    assert.deepEqual(byTopic, { examined: 1, released: 1, stillQuarantined: 0 });
  });

  it("survives a store failure part-way and resumes cleanly", async () => {
    const store = await createStore();
    for (const event of [future(10), future(11)]) await ingestAccordEvent({ event, treasuryAddress: treasury, store });
    let calls = 0;
    const flaky = {
      ...store,
      recordAccordEvent: async (entry) => {
        calls += 1;
        if (calls === 2) throw new Error("connection reset");
        return store.recordAccordEvent(entry);
      },
    };
    const options = { treasuryAddress: treasury, validator: upgradedValidator() };
    await assert.rejects(reprocessQuarantine({ store: flaky, ...options }), /connection reset/);
    assert.deepEqual(await reprocessQuarantine({ store: flaky, ...options }), { examined: 1, released: 1, stillQuarantined: 0 });
    assert.equal((await store.getAccordEvents({ limit: 10, offset: 0 })).length, 2);
    assert.equal((await store.countQuarantinedEvents()).quarantined, 0);
  });
});

describe("raw event serialisation", () => {
  it("keeps topic and value as base64 XDR that decodes back to the same event", () => {
    const event = accordEvent({ topic: "executed", payload: executedV2 });
    const raw = serializeRawEvent(event);
    assert.equal(typeof raw.topic[0], "string");
    assert.equal(createEventValidator().classify(raw, treasury).outcome, "accept");
    assert.deepEqual(serializeRawEvent(raw), raw, "serialising twice changes nothing");
  });
});

describe("quarantine metrics", () => {
  it("counts quarantined events and warnings from a batch result", () => {
    const metrics = createIndexerMetrics();
    recordBatchSuccess(metrics, {
      indexed: 1, heldBack: 0, reorg: null, latestLedger: 10, finalLedger: 10,
      quarantined: 3, quarantineReasons: { unknown_topic: 2, invalid_payload: 1 }, validationWarnings: 4,
    }, 10);
    const text = metrics.render();
    assert.match(text, /accord_indexer_events_quarantined_total\{reason="unknown_topic"\} 2/);
    assert.match(text, /accord_indexer_events_quarantined_total\{reason="invalid_payload"\} 1/);
    assert.match(text, /accord_indexer_event_validation_warnings_total 4/);
  });

  it("still accepts results that predate validation", () => {
    const metrics = createIndexerMetrics();
    assert.doesNotThrow(() => recordBatchSuccess(metrics, { indexed: 1, heldBack: 0, reorg: null, latestLedger: 10, finalLedger: 10 }, 10));
  });
});

describeEachBackend("schema and quarantine API", () => {
  async function withApi(store, run) {
    const api = createApi({
      store,
      readiness: createReadiness({ store }),
      metrics: createIndexerMetrics(),
      startLedger: 1,
      finalityLag: 1,
      tokenAddresses: new Map(),
    });
    await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
    try {
      return await run(`http://127.0.0.1:${api.address().port}`);
    } finally {
      await new Promise((resolve) => api.close(resolve));
    }
  }

  it("publishes the registry and the validation mode", async () => {
    const store = await createStore();
    await withApi(store, async (base) => {
      const body = await (await fetch(`${base}/schemas`)).json();
      assert.equal(body.mode, "enforce");
      assert.equal(body.strict, true);
      assert.equal(body.currentVersion, CURRENT_EVENT_SCHEMA_VERSION);
      assert.equal(body.schemas.length, Object.keys(eventCatalog).length);
      assert.equal(body.schemas[0].versions.at(-1).current, true);
    });
  });

  it("lists quarantined events with counts and filters, and rejects bad filters", async () => {
    const store = await createStore();
    await ingestAccordEvent({ event: accordEvent({ topic: "brand_new", payload: { version: 2 } }), treasuryAddress: treasury, store });
    await ingestAccordEvent({ event: accordEvent({ topic: "executed", payload: { id: "x", version: 2 } }), treasuryAddress: treasury, store });

    await withApi(store, async (base) => {
      const all = await (await fetch(`${base}/quarantine`)).json();
      assert.equal(all.events.length, 2);
      assert.equal(all.counts.quarantined, 2);
      assert.equal("raw" in all.events[0], false);

      const filtered = await (await fetch(`${base}/quarantine?reason=unknown_topic&raw=true`)).json();
      assert.deepEqual(filtered.events.map(({ topic }) => topic), ["brand_new"]);
      assert.equal(typeof filtered.events[0].raw.value, "string");
      assert.equal((await (await fetch(`${base}/quarantine?topic=executed`)).json()).events.length, 1);
      assert.equal((await (await fetch(`${base}/quarantine?status=released`)).json()).events.length, 0);
      assert.equal((await fetch(`${base}/quarantine?status=bogus`)).status, 400);
      assert.equal((await fetch(`${base}/quarantine?reason=bogus`)).status, 400);
    });
  });
});

describe("event validation config", () => {
  it("defaults to enforcing, strict and accepting unversioned events", () => {
    assert.deepEqual(resolveEventValidationConfig({}), { mode: "enforce", modeRejected: false, strict: true, allowUnversioned: true });
    assert.equal(loadIndexerConfig({}).eventValidation.mode, "enforce");
    assert.deepEqual(EVENT_VALIDATION_MODES, ["off", "warn", "enforce"]);
  });

  it("parses overrides and flags an unrecognised mode instead of silently disabling checks", () => {
    const config = resolveEventValidationConfig({
      EVENT_VALIDATION_MODE: " WARN ", EVENT_SCHEMA_STRICT: "false", EVENT_ALLOW_UNVERSIONED: "false",
    });
    assert.deepEqual(config, { mode: "warn", modeRejected: false, strict: false, allowUnversioned: false });
    const bad = resolveEventValidationConfig({ EVENT_VALIDATION_MODE: "none" });
    assert.equal(bad.mode, "enforce");
    assert.equal(bad.modeRejected, true);
  });

  it("lists every quarantine reason the schema allows", () => {
    const migration = loadMigrations().find((entry) => entry.name === "0011_quarantined_events");
    assert.ok(migration);
    for (const reason of QUARANTINE_REASONS) assert.ok(migration.sql.includes(`'${reason}'`), reason);
    assert.match(migration.sql, /dedupe_key TEXT NOT NULL UNIQUE/);
  });
});
