import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe } from "node:test";
import { Keypair, nativeToScVal, scValToNative, StrKey, xdr } from "@stellar/stellar-sdk";
import pg from "pg";
import { openPostgresStore } from "../src/store/postgres.js";
import { openLedgerStore } from "../src/store/sqlite.js";

export const treasury = StrKey.encodeContract(Buffer.alloc(32, 1));
export const sender = Keypair.random().publicKey();
export const tokenAddress = StrKey.encodeContract(Buffer.alloc(32, 2));
export const tokenAddresses = { USDC: tokenAddress, XLM: StrKey.encodeContract(Buffer.alloc(32, 3)) };

const cleanups = [];
let activeBackend = "sqlite";

/** Postgres runs whenever `TEST_POSTGRES_URL` points at a disposable database. */
export const postgresUrl = process.env.TEST_POSTGRES_URL?.trim() || null;
export const BACKENDS = ["sqlite", "postgres"];

/**
 * Registers the same suite once per storage backend. The Postgres run is
 * reported as skipped (not silently dropped) when no test database is configured.
 */
export function describeEachBackend(title, suite) {
  for (const backend of BACKENDS) {
    const options = backend === "postgres" && !postgresUrl ? { skip: "TEST_POSTGRES_URL is not set" } : {};
    describe(`${title} [${backend}]`, options, () => {
      before(() => {
        activeBackend = backend;
      });
      suite(backend);
    });
  }
}

/** Closes and removes every store created with `createStore` during a test. */
export async function cleanupTempStores() {
  for (const cleanup of cleanups.splice(0)) await cleanup();
}

/**
 * Opens a fresh, empty store on the backend the surrounding
 * `describeEachBackend` selected. Postgres stores get their own schema so tests
 * never see each other's rows.
 */
export async function createStore(backend = activeBackend) {
  if (backend === "postgres") {
    const schema = `test_${randomUUID().replaceAll("-", "")}`;
    const store = await openPostgresStore({ connectionString: postgresUrl, schema, poolMax: 4 });
    cleanups.push(async () => {
      await store.close().catch(() => {});
      const client = new pg.Client({ connectionString: postgresUrl });
      await client.connect();
      try {
        await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await client.end();
      }
    });
    return store;
  }

  const directory = mkdtempSync(join(tmpdir(), "accord-indexer-"));
  const store = openLedgerStore(join(directory, "ledger.sqlite"));
  cleanups.push(async () => {
    await store.close().catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  });
  return store;
}

export function encoded(value, type) {
  return xdr.ScVal.fromXDR(nativeToScVal(value, { type }).toXDR("base64"), "base64");
}

/**
 * Builds a raw RPC `transfer` event shaped exactly like `parseTokenTransferEvent`
 * expects, so tests exercise the real decoding path rather than a stub.
 */
export function makeEvent({
  id,
  from = sender,
  to = treasury,
  amount = 10n,
  ledger = 10,
  contractId = tokenAddress,
  closedAt = "2026-09-27T12:00:00Z",
} = {}) {
  const eventId = id ?? `event-${ledger}-${amount}`;
  return {
    id: eventId,
    pagingToken: eventId,
    contractId,
    ledger,
    ledgerClosedAt: closedAt,
    txHash: `tx-${eventId}`,
    topic: [encoded("transfer", "symbol"), encoded(from, "address"), encoded(to, "address")],
    value: encoded(amount, "i128"),
  };
}

export const tokenNames = (names = ["USDC"]) =>
  new Map(names.map((name) => [tokenAddresses[name].toLowerCase(), name]));

/**
 * A stand-in for the Soroban RPC that serves a fixed, in-memory event log.
 *
 * It mirrors the pagination contract the indexer relies on: `startLedger` opens
 * a window, a full page hands back a `cursor`, and `latestLedger` is the chain
 * head the tests can move around to simulate progress and rollbacks.
 */
export function createMockRpc({ events = [], latestLedger = 1, oldestLedger = 1, failOnRequest = null } = {}) {
  const state = {
    events: [...events].sort((a, b) => a.ledger - b.ledger),
    latestLedger,
    oldestLedger,
    requests: [],
    // Kept on state so a test can inject a failure and then clear it.
    failOnRequest,
  };

  const rpc = {
    state,
    /** Moves the chain head (and optionally the retention window) forward. */
    setChainHead(sequence, { oldest } = {}) {
      state.latestLedger = sequence;
      if (oldest !== undefined) state.oldestLedger = oldest;
    },
    /** Simulates a rollback by rewinding the head and dropping the orphaned tail. */
    rollbackTo(sequence) {
      state.events = state.events.filter((event) => event.ledger <= sequence);
      state.latestLedger = sequence;
    },
    async getLatestLedger() {
      return { sequence: state.latestLedger };
    },
    async getLedgers() {
      return { oldestLedger: state.oldestLedger, latestLedger: state.latestLedger, ledgers: [] };
    },
    async getEvents(request) {
      state.requests.push(request);
      if (state.failOnRequest && state.failOnRequest(request, state.requests.length)) {
        throw new Error("RPC unavailable");
      }
      const limit = request.limit ?? 10;
      let pool = state.events;
      if (request.cursor) {
        const index = pool.findIndex((event) => event.pagingToken === request.cursor);
        pool = index === -1 ? [] : pool.slice(index + 1);
      } else if (request.startLedger != null) {
        pool = pool.filter((event) => event.ledger >= request.startLedger);
      }
      const page = pool.slice(0, limit);
      return {
        events: page,
        // A full page always hands back a cursor, exactly like the real RPC;
        // the walk only knows it is done when a short page comes back.
        cursor: page.length === limit ? page[page.length - 1].pagingToken : undefined,
        latestLedger: state.latestLedger,
      };
    },
  };

  return rpc;
}

/** Expected per-token balance after folding the given events in chain order. */
export function expectedBalances(events) {
  const running = new Map();
  for (const event of [...events].sort((a, b) => a.ledger - b.ledger)) {
    // topic = [eventName, from, to] — all ScVals that must be decoded first.
    const to = String(scValToNative(event.topic[2]));
    const direction = to.toLowerCase() === treasury.toLowerCase() ? 1n : -1n;
    const amount = BigInt(scValToNative(event.value));
    const token = Object.entries(tokenAddresses)
      .find(([, address]) => address.toLowerCase() === String(event.contractId).toLowerCase())?.[0] ?? "USDC";
    running.set(token, (running.get(token) ?? 0n) + direction * amount);
  }
  return Object.fromEntries([...running].map(([token, balance]) => [token, balance.toString()]));
}
