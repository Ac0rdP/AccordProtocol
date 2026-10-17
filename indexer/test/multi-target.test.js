import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { loadTargets, networkFromPassphrase, targetKey } from "../src/config.js";
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

const usdc = contractAddress(2);
const xlm = contractAddress(3);

const treasuryA = contractAddress(10);
const treasuryB = contractAddress(11);

const testnetTarget = target({
  id: "testnet-a",
  network: "testnet",
  contractId: treasuryA,
  tokens: [{ name: "USDC", address: usdc }],
  startLedger: 40,
});
const pubnetTarget = target({
  id: "pubnet-b",
  network: "pubnet",
  contractId: treasuryB,
  tokens: [{ name: "XLM", address: xlm }],
  startLedger: 900,
});

afterEach(cleanupTempDirectories);

describe("multi-contract, multi-network configuration", () => {
  it("builds one legacy target from the single-contract environment variables", () => {
    const targets = loadTargets({
      ACCORD_CONTRACT_ID: treasuryA,
      SIM_SOURCE: sender,
      INDEXER_START_LEDGER: "40",
      XLM_TOKEN_ADDRESS: xlm,
      USDC_TOKEN_ADDRESS: usdc,
    });

    assert.equal(targets.length, 1);
    assert.equal(targets[0].network, "testnet");
    assert.equal(targets[0].contractId, treasuryA);
    assert.deepEqual(
      targets[0].tokens.map(({ name }) => name),
      ["XLM", "USDC"]
    );
  });

  it("reads several targets from INDEXER_TARGETS and inherits unset fields", () => {
    const targets = loadTargets({
      SIM_SOURCE: sender,
      INDEXER_START_LEDGER: "40",
      USDC_TOKEN_ADDRESS: usdc,
      INDEXER_TARGETS: JSON.stringify([
        { id: "testnet-a", contractId: treasuryA },
        {
          id: "pubnet-b",
          contractId: treasuryB,
          networkPassphrase: "Public Global Stellar Network ; September 2015",
          rpcUrl: "https://mainnet.example",
          startLedger: 900,
          tokens: [{ name: "xlm", address: xlm }],
        },
      ]),
    });

    assert.deepEqual(
      targets.map(({ network, contractId }) => targetKey({ network, contractId })),
      [`testnet/${treasuryA}`, `pubnet/${treasuryB}`]
    );
    assert.equal(targets[0].startLedger, 40, "inherits the shared start ledger");
    assert.equal(targets[0].tokens[0].address, usdc, "inherits the shared token list");
    assert.equal(targets[1].rpcUrl, "https://mainnet.example");
    assert.equal(targets[1].tokens[0].name, "XLM", "token symbols are normalised");
  });

  it("rejects two targets for the same network and contract", () => {
    assert.throws(
      () =>
        loadTargets({
          SIM_SOURCE: sender,
          INDEXER_START_LEDGER: "40",
          USDC_TOKEN_ADDRESS: usdc,
          INDEXER_TARGETS: JSON.stringify([{ contractId: treasuryA }, { contractId: treasuryA }]),
        }),
      /Duplicate indexer target/
    );
  });

  it("maps known passphrases to network names and falls back to custom", () => {
    assert.equal(networkFromPassphrase("Test SDF Network ; September 2015"), "testnet");
    assert.equal(networkFromPassphrase("Public Global Stellar Network ; September 2015"), "pubnet");
    assert.equal(networkFromPassphrase("Something Else"), "custom");
  });
});

describe("indexing two contracts into one store", () => {
  it("tags rows per target, filters by them, and keeps checkpoints separate", async () => {
    const store = createStore();

    const testnetRpc = stubStellar([
      {
        events: [
          transferEvent({ id: "a-1", contractId: usdc, to: treasuryA, amount: 100n, ledger: 41 }),
          transferEvent({
            id: "a-2",
            contractId: usdc,
            from: treasuryA,
            to: sender,
            amount: 40n,
            ledger: 42,
          }),
        ],
        latestLedger: 42,
      },
    ]);
    const pubnetRpc = stubStellar([
      {
        events: [
          transferEvent({ id: "b-1", contractId: xlm, to: treasuryB, amount: 7n, ledger: 901 }),
        ],
        latestLedger: 901,
      },
    ]);

    await indexEventBatch({ stellar: testnetRpc, store, target: testnetTarget });
    await indexEventBatch({ stellar: pubnetRpc, store, target: pubnetTarget });

    // Both contracts are indexed.
    assert.equal(store.getEntries({ limit: 10, offset: 0 }).length, 3);

    // Rows carry their network and contract, and filter on them.
    const testnetEntries = store.getEntries({
      network: "testnet",
      contractId: treasuryA,
      limit: 10,
      offset: 0,
    });
    assert.deepEqual(
      testnetEntries.map(({ eventId }) => eventId),
      ["a-1", "a-2"]
    );
    assert.ok(testnetEntries.every((entry) => entry.network === "testnet"));
    assert.ok(testnetEntries.every((entry) => entry.contractId === treasuryA));

    const pubnetEntries = store.getEntries({ network: "pubnet", limit: 10, offset: 0 });
    assert.deepEqual(
      pubnetEntries.map(({ eventId, contractId }) => [eventId, contractId]),
      [["b-1", treasuryB]]
    );

    // Balances are tracked per contract, not pooled.
    assert.equal(store.getBalance({ network: "testnet", contractId: treasuryA, token: "USDC" }), "60");
    assert.equal(store.getBalance({ network: "pubnet", contractId: treasuryB, token: "XLM" }), "7");
    assert.equal(store.getBalance({ network: "testnet", contractId: treasuryB, token: "USDC" }), "0");

    // Checkpoints advance independently.
    assert.equal(store.getState({ network: "testnet", contractId: treasuryA }, "next_ledger"), "43");
    assert.equal(store.getState({ network: "pubnet", contractId: treasuryB }, "next_ledger"), "902");
    assert.equal(store.getCheckpoints().length, 4, "two keys for each of the two targets");
    assert.equal(store.getCheckpoints({ network: "pubnet" }).length, 2);

    store.close();
  });

  it("keeps identical event ids from different contracts apart", async () => {
    const store = createStore();
    const sharedEventId = "ledger-42-0";

    await indexEventBatch({
      stellar: stubStellar([
        {
          events: [
            transferEvent({ id: sharedEventId, contractId: usdc, to: treasuryA, amount: 5n }),
          ],
          latestLedger: 42,
        },
      ]),
      store,
      target: testnetTarget,
    });
    await indexEventBatch({
      stellar: stubStellar([
        {
          events: [transferEvent({ id: sharedEventId, contractId: xlm, to: treasuryB, amount: 9n })],
          latestLedger: 901,
        },
      ]),
      store,
      target: pubnetTarget,
    });

    assert.equal(store.getEntries({ limit: 10, offset: 0 }).length, 2);
    assert.equal(store.getBalance({ network: "testnet", contractId: treasuryA, token: "USDC" }), "5");
    assert.equal(store.getBalance({ network: "pubnet", contractId: treasuryB, token: "XLM" }), "9");
    store.close();
  });

  it("resumes each target from its own checkpoint", async () => {
    const store = createStore();
    store.setState({ network: "testnet", contractId: treasuryA }, "next_ledger", 500);

    const testnetRpc = stubStellar([{ events: [], latestLedger: 500 }]);
    const pubnetRpc = stubStellar([{ events: [], latestLedger: 900 }]);
    await indexEventBatch({ stellar: testnetRpc, store, target: testnetTarget });
    await indexEventBatch({ stellar: pubnetRpc, store, target: pubnetTarget });

    assert.equal(testnetRpc.requests[0].startLedger, 500, "uses its stored checkpoint");
    assert.equal(pubnetRpc.requests[0].startLedger, 900, "falls back to its configured start ledger");
    store.close();
  });
});
