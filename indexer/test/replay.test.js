import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { backfill } from "../src/commands.js";
import {
  formatReplayEvent,
  openReplayStore,
  readLiveCheckpoint,
  replay,
  replayEventRecord,
  resolveReplayWindow,
} from "../src/replay.js";
import { cleanupTempStores, createMockRpc, createStore, makeEvent, tokenAddresses, treasury } from "./helpers.js";

afterEach(cleanupTempStores);

const tokens = [{ name: "USDC", address: tokenAddresses.USDC }];
const indexerDir = fileURLToPath(new URL("..", import.meta.url));

function chain(first = 10, last = 19, amount = 10n) {
  const events = [];
  for (let ledger = first; ledger <= last; ledger += 1) events.push(makeEvent({ id: `e${ledger}`, ledger, amount }));
  return events;
}

async function snapshot(store) {
  return {
    entries: await store.getEntries({ limit: 1000, offset: 0 }),
    events: await store.getAccordEvents({ limit: 1000, offset: 0 }),
    balance: await store.getBalance("USDC"),
    nextLedger: await store.getState("next_ledger"),
    cursor: await store.getState("event_cursor"),
  };
}

describe("replay window", () => {
  it("accepts an explicit range", () => {
    assert.deepEqual(resolveReplayWindow({ from: 5, to: 9 }), { from: 5, to: 9, checkpoint: null, relativeTo: null });
  });

  it("replays the ledgers before the checkpoint", () => {
    const window = resolveReplayWindow({ beforeCheckpoint: 5, checkpoint: 100 });
    assert.deepEqual([window.from, window.to, window.relativeTo], [95, 99, "before-checkpoint"]);
    // Never reaches below ledger 1.
    assert.equal(resolveReplayWindow({ beforeCheckpoint: 500, checkpoint: 100 }).from, 1);
  });

  it("replays the ledgers after the checkpoint", () => {
    const window = resolveReplayWindow({ afterCheckpoint: 5, checkpoint: 100 });
    assert.deepEqual([window.from, window.to, window.relativeTo], [100, 104, "after-checkpoint"]);
  });

  it("rejects ambiguous or incomplete input", () => {
    assert.throws(() => resolveReplayWindow({ from: 5 }), /needs --from and --to/);
    assert.throws(() => resolveReplayWindow({ from: 9, to: 5 }), /must not be before/);
    assert.throws(() => resolveReplayWindow({ beforeCheckpoint: 2, afterCheckpoint: 2, checkpoint: 9 }), /cannot be combined/);
    assert.throws(() => resolveReplayWindow({ from: 1, to: 2, beforeCheckpoint: 2, checkpoint: 9 }), /cannot be combined/);
    assert.throws(() => resolveReplayWindow({ beforeCheckpoint: 2 }), /no checkpoint/);
    assert.throws(() => resolveReplayWindow({ beforeCheckpoint: 0, checkpoint: 9 }), /positive integer/);
  });
});

describe("replay", () => {
  it("replays a chosen range into an isolated store and prints per-event detail", async () => {
    const stellar = createMockRpc({ events: chain(), oldestLedger: 10, latestLedger: 30 });
    const replayStore = openReplayStore();
    const lines = [];

    const result = await replay({
      stellar,
      replayStore,
      tokens,
      treasuryAddress: treasury,
      from: 12,
      to: 14,
      finalityLag: 2,
      onEvent: (detail) => lines.push(formatReplayEvent(detail)),
    });

    assert.equal(result.complete, true);
    assert.equal(result.eventsSeen, 3);
    assert.equal(result.eventsIndexed, 3);
    assert.deepEqual(result.balances, { USDC: "30" });
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^ledger 12 event e12 tx=tx-e12 :: USDC inflow 10 <- G/);
    assert.match(lines[2], /^ledger 14 event e14 /);
    // Only the requested range was ingested.
    const entries = await replayStore.getEntries({ limit: 100, offset: 0 });
    assert.deepEqual(entries.map((entry) => entry.ledger), [12, 13, 14]);
    await replayStore.close();
  });

  it("leaves live data untouched", async () => {
    const live = await createStore("sqlite");
    const liveRpc = createMockRpc({ events: chain(), oldestLedger: 10, latestLedger: 30 });
    await backfill({ stellar: liveRpc, store: live, tokens, treasuryAddress: treasury, finalityLag: 2 });
    const before = await snapshot(live);
    assert.equal(before.entries.length, 10);

    const replayStore = openReplayStore();
    // The replayed range overlaps the live data and the chain now differs.
    const stellar = createMockRpc({ events: chain(12, 16, 99n), oldestLedger: 10, latestLedger: 40 });
    await replay({ stellar, replayStore, tokens, treasuryAddress: treasury, from: 12, to: 16, finalityLag: 2 });
    await replayStore.close();

    assert.deepEqual(await snapshot(live), before);
  });

  it("clamps the range to the final ledger", async () => {
    const stellar = createMockRpc({ events: chain(), oldestLedger: 10, latestLedger: 14 });
    const replayStore = openReplayStore();
    const result = await replay({ stellar, replayStore, tokens, treasuryAddress: treasury, from: 10, to: 50, finalityLag: 2 });
    assert.equal(result.end, 12);
    assert.equal(result.clamped, true);
    assert.equal(result.eventsSeen, 3);
    await replayStore.close();
  });

  it("reports ignored and duplicate events", () => {
    const event = makeEvent({ id: "x1", ledger: 4 });
    const ignored = formatReplayEvent({ event, ledger: 4, transfer: null, accord: null });
    assert.match(ignored, /^ledger 4 event x1 .*:: ignored/);
    const record = replayEventRecord({ event, ledger: 4, transfer: null, accord: null, transferRecorded: false, accordRecorded: false });
    assert.deepEqual(record, {
      kind: "event", ledger: 4, id: "x1", transactionHash: "tx-x1",
      transfer: null, transferRecorded: false, accord: null, accordRecorded: false,
    });
  });

  it("refuses to write into the live SQLite file", () => {
    assert.throws(
      () => openReplayStore({ path: "./data/../data/treasury.sqlite", liveDatabasePath: "./data/treasury.sqlite" }),
      /must not be the live DATABASE_PATH/
    );
  });
});

describe("replay from a checkpoint", () => {
  it("reads the live checkpoint without writing, and replays before and after it", async () => {
    const live = await createStore("sqlite");
    const directory = mkdtempSync(join(tmpdir(), "accord-replay-"));
    try {
      assert.equal(await readLiveCheckpoint({ backend: "sqlite", databasePath: join(directory, "missing.sqlite") }), null);

      // A live store at a known checkpoint, persisted to a file we can reopen read-only.
      const { openLedgerStore } = await import("../src/store/sqlite.js");
      const path = join(directory, "live.sqlite");
      const file = openLedgerStore(path);
      await file.setState("next_ledger", "15");
      await file.close();
      const checkpoint = await readLiveCheckpoint({ backend: "sqlite", databasePath: path });
      assert.equal(checkpoint, 15);

      const stellar = createMockRpc({ events: chain(), oldestLedger: 10, latestLedger: 60 });
      const run = async (options) => {
        const store = openReplayStore();
        const window = resolveReplayWindow({ ...options, checkpoint });
        const result = await replay({ stellar, replayStore: store, tokens, treasuryAddress: treasury, from: window.from, to: window.to, finalityLag: 2 });
        const ledgers = (await store.getEntries({ limit: 100, offset: 0 })).map((entry) => entry.ledger);
        await store.close();
        return { result, ledgers };
      };

      assert.deepEqual((await run({ beforeCheckpoint: 3 })).ledgers, [12, 13, 14]);
      assert.deepEqual((await run({ afterCheckpoint: 3 })).ledgers, [15, 16, 17]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    void live;
  });
});

describe("replay CLI", () => {
  const env = {
    ...process.env,
    ACCORD_CONTRACT_ID: treasury,
    XLM_TOKEN_ADDRESS: tokenAddresses.XLM,
    USDC_TOKEN_ADDRESS: tokenAddresses.USDC,
  };
  const run = (...args) => spawnSync(process.execPath, ["src/index.js", ...args], { cwd: indexerDir, env, encoding: "utf8" });

  it("documents the replay command and options", () => {
    const { stdout, status } = run("--help");
    assert.equal(status, 0);
    for (const text of ["replay ", "--before-checkpoint", "--after-checkpoint", "--replay-store"]) {
      assert.ok(stdout.includes(text), `help should mention ${text}`);
    }
  });

  it("rejects an incomplete replay range before touching any store", () => {
    const missing = run("replay", "--from", "5");
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /needs --from and --to/);
    const mixed = run("replay", "--from", "5", "--to", "9", "--before-checkpoint", "2", "--checkpoint", "50");
    assert.match(mixed.stderr, /cannot be combined/);
    const bad = run("replay", "--before-checkpoint", "0");
    assert.match(bad.stderr, /--before-checkpoint must be a positive integer/);
  });
});
