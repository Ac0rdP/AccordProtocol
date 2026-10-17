import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { applyRetention, loadRetentionPolicy } from "../src/retention.js";
import {
  cleanupTempDirectories,
  createStore,
  createTempDirectory,
  contractAddress,
  sender,
  target,
} from "./helpers.js";

const main = target({ contractId: contractAddress(10) });
const other = target({
  id: "pubnet-b",
  network: "pubnet",
  contractId: contractAddress(11),
  tokens: [{ name: "XLM", address: contractAddress(3) }],
});
const scope = { network: main.network, contractId: main.contractId };
const now = new Date("2026-10-17T00:00:00.000Z");

function seed(store, scopeOverride = scope, token = "USDC") {
  // Two old days and one recent day of activity.
  const rows = [
    { eventId: "old-1", day: "2026-01-02", amount: "100", direction: "inflow", ledger: 10 },
    { eventId: "old-2", day: "2026-01-02", amount: "40", direction: "outflow", ledger: 11 },
    { eventId: "old-3", day: "2026-01-03", amount: "10", direction: "inflow", ledger: 12 },
    { eventId: "new-1", day: "2026-10-16", amount: "7", direction: "inflow", ledger: 13 },
  ];
  for (const row of rows) {
    store.recordTransfer({
      ...scopeOverride,
      eventId: row.eventId,
      token,
      tokenAddress: contractAddress(2),
      direction: row.direction,
      amount: row.amount,
      ledger: row.ledger,
      transactionHash: `tx-${row.eventId}`,
      occurredAt: `${row.day}T12:00:00.000Z`,
      from: sender,
      to: scopeOverride.contractId,
    });
  }
  for (const [index, day] of ["2026-01-02", "2026-01-03", "2026-10-16"].entries()) {
    store.recordAccordEvent({
      ...scopeOverride,
      eventId: `created-${index}`,
      topic: "created",
      payload: { id: index },
      ledger: 20 + index,
      transactionHash: `tx-created-${index}`,
      occurredAt: `${day}T12:00:00.000Z`,
    });
  }
}

afterEach(cleanupTempDirectories);

describe("retention policy configuration", () => {
  it("keeps everything by default", () => {
    const policy = loadRetentionPolicy({});
    assert.equal(policy.rawEventDays, 0);
    assert.equal(policy.enabled, false);
  });

  it("reads each window from the environment", () => {
    const policy = loadRetentionPolicy({
      RETENTION_RAW_EVENT_DAYS: "90",
      RETENTION_AGGREGATE_DAYS: "730",
      RETENTION_RECONCILIATION_DAYS: "30",
      RETENTION_ARCHIVE_DIR: "./archive",
    });
    assert.equal(policy.rawEventDays, 90);
    assert.equal(policy.aggregateDays, 730);
    assert.equal(policy.reconciliationDays, 30);
    assert.equal(policy.archiveDir, "./archive");
    assert.equal(policy.enabled, true);
  });

  it("refuses an aggregate window shorter than the raw window", () => {
    assert.throws(
      () => loadRetentionPolicy({ RETENTION_RAW_EVENT_DAYS: "90", RETENTION_AGGREGATE_DAYS: "30" }),
      /greater than or equal to RETENTION_RAW_EVENT_DAYS/
    );
  });

  it("refuses a negative window", () => {
    assert.throws(
      () => loadRetentionPolicy({ RETENTION_RAW_EVENT_DAYS: "-1" }),
      /non-negative number of days/
    );
  });
});

describe("applying retention", () => {
  it("rolls old rows into daily aggregates before pruning them", () => {
    const store = createStore();
    seed(store);
    const balanceBefore = store.getBalance({ ...scope, token: "USDC" });

    const [run] = applyRetention({
      store,
      targets: [main],
      policy: loadRetentionPolicy({ RETENTION_RAW_EVENT_DAYS: "30" }),
      now,
    });

    assert.equal(run.entriesRolledUp, 3);
    assert.equal(run.entriesRemoved, 3);
    assert.equal(run.eventsRolledUp, 2);
    assert.equal(run.eventsRemoved, 2);

    // Only the recent rows survive as raw history.
    assert.deepEqual(
      store.getEntries({ ...scope, limit: 10, offset: 0 }).map(({ eventId }) => eventId),
      ["new-1"]
    );

    // The pruned days are preserved as aggregates.
    const aggregates = store.getDailyAggregates(scope);
    assert.deepEqual(
      aggregates.map(({ day, inflow, outflow, entryCount }) => [day, inflow, outflow, entryCount]),
      [
        ["2026-01-02", "100", "40", 2],
        ["2026-01-03", "10", "0", 1],
      ]
    );

    // Running balances are untouched by pruning, so reports still reconcile.
    assert.equal(store.getBalance({ ...scope, token: "USDC" }), balanceBefore);
    assert.equal(store.getBalance({ ...scope, token: "USDC" }), "77");

    // Event counts still include the pruned history.
    assert.equal(store.countAccordEvents({ ...scope, topic: "created" }), 3);

    store.close();
  });

  it("is idempotent and does not double-count aggregates on a second run", () => {
    const store = createStore();
    seed(store);
    const policy = loadRetentionPolicy({ RETENTION_RAW_EVENT_DAYS: "30" });

    applyRetention({ store, targets: [main], policy, now });
    const first = store.getDailyAggregates(scope);
    applyRetention({ store, targets: [main], policy, now });
    const second = store.getDailyAggregates(scope);

    assert.deepEqual(first, second);
    assert.equal(store.countAccordEvents({ ...scope, topic: "created" }), 3);
    store.close();
  });

  it("archives pruned rows as JSON lines when an archive directory is set", () => {
    const store = createStore();
    seed(store);
    const archiveDir = createTempDirectory();

    const [run] = applyRetention({
      store,
      targets: [main],
      policy: loadRetentionPolicy({
        RETENTION_RAW_EVENT_DAYS: "30",
        RETENTION_ARCHIVE_DIR: archiveDir,
      }),
      now,
    });

    assert.equal(run.archivePaths.length, 2);
    const directory = join(archiveDir, main.network, main.contractId);
    const files = readdirSync(directory);
    assert.equal(files.filter((name) => name.startsWith("ledger_entries-")).length, 1);
    assert.equal(files.filter((name) => name.startsWith("accord_events-")).length, 1);

    const archived = readFileSync(run.archivePaths[0], "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      archived.map(({ eventId }) => eventId),
      ["old-1", "old-2", "old-3"]
    );
    assert.equal(archived[0].network, main.network);
    assert.equal(archived[0].contractId, main.contractId);
    store.close();
  });

  it("drops aggregates past the longer aggregate window", () => {
    const store = createStore();
    seed(store);

    applyRetention({
      store,
      targets: [main],
      policy: loadRetentionPolicy({ RETENTION_RAW_EVENT_DAYS: "30" }),
      now,
    });
    assert.equal(store.getDailyAggregates(scope).length, 2);

    const [run] = applyRetention({
      store,
      targets: [main],
      policy: loadRetentionPolicy({
        RETENTION_RAW_EVENT_DAYS: "30",
        RETENTION_AGGREGATE_DAYS: "60",
      }),
      now,
    });

    assert.equal(run.aggregatesRemoved, 4, "two ledger days and two event days");
    assert.equal(store.getDailyAggregates(scope).length, 0);
    store.close();
  });

  it("prunes old reconciliation rows but keeps the latest per subject", () => {
    const store = createStore();
    for (const checkedAt of ["2026-01-02T00:00:00.000Z", "2026-01-03T00:00:00.000Z"]) {
      store.recordReconciliation({
        ...scope,
        check: "token_balance",
        subject: "USDC",
        subjectAddress: contractAddress(2),
        checkedAt,
        impliedBalance: "1",
        actualBalance: "1",
        drift: "0",
        status: "ok",
      });
    }

    const [run] = applyRetention({
      store,
      targets: [main],
      policy: loadRetentionPolicy({ RETENTION_RECONCILIATION_DAYS: "30" }),
      now,
    });

    assert.equal(run.reconciliationsRemoved, 1);
    const latest = store.getLatestReconciliations(scope);
    assert.equal(latest.length, 1);
    assert.equal(latest[0].checkedAt, "2026-01-03T00:00:00.000Z");
    store.close();
  });

  it("applies the policy to each target independently", () => {
    const store = createStore();
    seed(store);
    seed(store, { network: other.network, contractId: other.contractId }, "XLM");

    const runs = applyRetention({
      store,
      targets: [main, other],
      policy: loadRetentionPolicy({ RETENTION_RAW_EVENT_DAYS: "30" }),
      now,
    });

    assert.equal(runs.length, 2);
    assert.ok(runs.every((run) => run.entriesRemoved === 3));
    assert.equal(store.getEntries({ limit: 20, offset: 0 }).length, 2, "one recent row per target");
    assert.equal(store.getDailyAggregates({ network: other.network }).length, 2);
    assert.equal(store.getRetentionRuns({ network: main.network }).length, 1);
    store.close();
  });

  it("does nothing when no window is configured", () => {
    const store = createStore();
    seed(store);

    const runs = applyRetention({ store, targets: [main], policy: loadRetentionPolicy({}), now });

    assert.deepEqual(runs, []);
    assert.equal(store.getEntries({ ...scope, limit: 10, offset: 0 }).length, 4);
    store.close();
  });
});
