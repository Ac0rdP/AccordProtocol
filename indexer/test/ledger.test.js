import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseTokenTransferEvent } from "../src/events.js";
import { indexEventBatch } from "../src/indexing.js";
import {
  cleanupTempDirectories,
  createStore,
  contractAddress,
  sender,
  stubStellar,
  target,
  transferEvent,
} from "./helpers.js";

const main = target();
const treasury = main.contractId;
const tokenAddress = main.tokens[0].address;
const tokenNames = new Map([[tokenAddress.toLowerCase(), "USDC"]]);
const scope = { network: main.network, contractId: treasury };

afterEach(cleanupTempDirectories);

describe("treasury ledger", () => {
  it("records transfers once and keeps per-token running balances", () => {
    const store = createStore();
    const entry = parseTokenTransferEvent(
      transferEvent({ contractId: tokenAddress, to: treasury }),
      tokenNames,
      treasury,
      main
    );

    assert.ok(entry);
    assert.equal(entry.network, "testnet");
    assert.equal(entry.contractId, treasury);
    assert.equal(store.recordTransfer(entry), true);
    assert.equal(store.recordTransfer(entry), false);
    assert.equal(store.getBalance({ ...scope, token: "USDC" }), "125");

    const outflow = parseTokenTransferEvent(
      transferEvent({ id: "event-2", contractId: tokenAddress, from: treasury, to: sender, amount: 25n }),
      tokenNames,
      treasury,
      main
    );
    assert.ok(outflow);
    assert.equal(outflow.direction, "outflow");
    store.recordTransfer(outflow);

    assert.equal(store.getBalance({ ...scope, token: "USDC" }), "100");
    assert.equal(
      store.getEntries({
        ...scope,
        token: "USDC",
        from: "2026-09-27T00:00:00.000Z",
        to: "2026-09-27T23:59:59.999Z",
        limit: 10,
        offset: 0,
      }).length,
      2
    );
    store.close();
  });

  it("ignores unrelated token activity", () => {
    const parsed = parseTokenTransferEvent(
      transferEvent({ contractId: tokenAddress, to: sender }),
      tokenNames,
      treasury,
      main
    );
    assert.equal(parsed, null);
  });

  it("stores the latest reconciliation result per check and subject", () => {
    const store = createStore();
    store.recordReconciliation({
      ...scope,
      check: "token_balance",
      subject: "XLM",
      subjectAddress: tokenAddress,
      checkedAt: "2026-09-27T12:00:00.000Z",
      impliedBalance: "100",
      actualBalance: "125",
      drift: "25",
      status: "drift",
    });
    store.recordReconciliation({
      ...scope,
      check: "token_balance",
      subject: "XLM",
      subjectAddress: tokenAddress,
      checkedAt: "2026-09-27T12:01:00.000Z",
      impliedBalance: "125",
      actualBalance: "125",
      drift: "0",
      status: "ok",
    });

    assert.equal(store.getLatestReconciliations().length, 1);
    assert.equal(store.getLatestReconciliations()[0].drift, "0");
    assert.equal(store.getLatestReconciliations()[0].status, "ok");
    store.close();
  });

  it("replays configured ledgers across pages before handing off to live indexing", async () => {
    const store = createStore();
    const stellar = stubStellar([
      {
        events: [
          transferEvent({ id: "event-1", contractId: tokenAddress, to: treasury, amount: 10n }),
          transferEvent({ id: "event-2", contractId: tokenAddress, to: treasury, amount: 20n }),
        ],
        cursor: "page-1",
        latestLedger: 42,
      },
      {
        events: [
          transferEvent({ id: "event-3", contractId: tokenAddress, to: treasury, amount: 30n, ledger: 43 }),
        ],
        latestLedger: 43,
      },
    ]);

    await indexEventBatch({ stellar, store, target: main, pageLimit: 2 });

    assert.equal(stellar.requests[0].startLedger, 40);
    assert.equal(stellar.requests[1].cursor, "page-1");
    assert.deepEqual(
      store
        .getEntries({ ...scope, token: "USDC", limit: 10, offset: 0 })
        .map(({ eventId, balance }) => [eventId, balance]),
      [
        ["event-1", "10"],
        ["event-2", "30"],
        ["event-3", "60"],
      ]
    );
    assert.equal(store.getState(scope, "next_ledger"), "44");
    assert.equal(store.getState(scope, "event_cursor"), "");
    store.close();
  });

  it("filters the token-transfer subscription to the contract and its tokens", async () => {
    const store = createStore();
    const stellar = stubStellar([{ events: [], latestLedger: 50 }]);

    await indexEventBatch({ stellar, store, target: main });

    assert.deepEqual(stellar.requests[0].filters[0].contractIds, [treasury, tokenAddress]);
    store.close();
  });
});

describe("legacy databases", () => {
  it("rejects a pre-multi-network database when no legacy target is supplied", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { join } = await import("node:path");
    const { createTempDirectory } = await import("./helpers.js");
    const { openLedgerStore } = await import("../src/ledger.js");

    const path = join(createTempDirectory(), "legacy.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE indexer_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO indexer_state (key, value) VALUES ('next_ledger', '99');
    `);
    legacy.close();

    assert.throws(() => openLedgerStore(path), /predates multi-network indexing/);

    const migrated = openLedgerStore(path, {
      legacyTarget: { network: "testnet", contractId: contractAddress(7) },
    });
    assert.equal(
      migrated.getState({ network: "testnet", contractId: contractAddress(7) }, "next_ledger"),
      "99"
    );
    migrated.close();
  });
});
