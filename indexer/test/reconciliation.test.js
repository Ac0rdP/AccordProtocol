import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  createAlerter,
  reconcileTarget,
  renderMetrics,
  runReconciliation,
} from "../src/reconciliation.js";
import { applyRetention, loadRetentionPolicy } from "../src/retention.js";
import {
  cleanupTempDirectories,
  createStore,
  contractAddress,
  sender,
  target,
} from "./helpers.js";

const usdc = contractAddress(2);
const xlm = contractAddress(3);
const main = target({ contractId: contractAddress(10), tokens: [{ name: "USDC", address: usdc }] });
const other = target({
  id: "pubnet-b",
  network: "pubnet",
  contractId: contractAddress(11),
  tokens: [{ name: "XLM", address: xlm }],
});
const scope = { network: main.network, contractId: main.contractId };
const checkedAt = new Date("2026-10-17T09:00:00.000Z");
const now = () => checkedAt;

function chainReader({ balances = {}, totalProposals = 0n, failBalance = false } = {}) {
  return {
    async readTokenBalance(_target, tokenAddress) {
      if (failBalance) throw new Error("rpc unavailable");
      return balances[tokenAddress] ?? 0n;
    },
    async readTotalProposals() {
      return totalProposals;
    },
  };
}

function recordInflow(store, { scope: entryScope = scope, eventId, amount, occurredAt, token = "USDC" }) {
  store.recordTransfer({
    ...entryScope,
    eventId,
    token,
    tokenAddress: usdc,
    direction: "inflow",
    amount,
    ledger: 10,
    transactionHash: `tx-${eventId}`,
    occurredAt,
    from: sender,
    to: entryScope.contractId,
  });
}

afterEach(cleanupTempDirectories);

describe("reconciling indexed state against the chain", () => {
  it("reports every check as ok when the chain agrees", async () => {
    const store = createStore();
    recordInflow(store, { eventId: "a", amount: "500", occurredAt: "2026-10-16T12:00:00.000Z" });
    store.recordAccordEvent({
      ...scope,
      eventId: "created-0",
      topic: "created",
      payload: {},
      ledger: 11,
      transactionHash: "tx-created-0",
      occurredAt: "2026-10-16T12:00:00.000Z",
    });

    const results = await reconcileTarget({
      store,
      target: main,
      chainReader: chainReader({ balances: { [usdc]: 500n }, totalProposals: 1n }),
      now,
    });

    assert.deepEqual(
      results.map(({ check, subject, status, drift }) => [check, subject, status, drift]),
      [
        ["token_balance", "USDC", "ok", "0"],
        ["total_proposals", "proposals", "ok", "0"],
      ]
    );
    store.close();
  });

  it("detects a drifted balance introduced by a missed event", async () => {
    const store = createStore();
    // The indexer only saw 500 of the 650 that actually reached the treasury.
    recordInflow(store, { eventId: "a", amount: "500", occurredAt: "2026-10-16T12:00:00.000Z" });

    const results = await reconcileTarget({
      store,
      target: main,
      chainReader: chainReader({ balances: { [usdc]: 650n } }),
      now,
    });

    const balance = results.find((result) => result.check === "token_balance");
    assert.equal(balance.status, "drift");
    assert.equal(balance.impliedBalance, "500");
    assert.equal(balance.actualBalance, "650");
    assert.equal(balance.drift, "150", "drift is actual minus implied");
    assert.equal(balance.subjectAddress, usdc, "names the token so drift can be investigated");
    store.close();
  });

  it("detects a missed proposal event", async () => {
    const store = createStore();

    const results = await reconcileTarget({
      store,
      target: main,
      chainReader: chainReader({ totalProposals: 4n }),
      now,
    });

    const proposals = results.find((result) => result.check === "total_proposals");
    assert.equal(proposals.status, "drift");
    assert.equal(proposals.impliedBalance, "0");
    assert.equal(proposals.actualBalance, "4");
    assert.equal(proposals.drift, "4");
    store.close();
  });

  it("still reconciles correctly after retention has pruned raw history", async () => {
    const store = createStore();
    recordInflow(store, { eventId: "old", amount: "500", occurredAt: "2026-01-02T12:00:00.000Z" });
    store.recordAccordEvent({
      ...scope,
      eventId: "created-0",
      topic: "created",
      payload: {},
      ledger: 11,
      transactionHash: "tx-created-0",
      occurredAt: "2026-01-02T12:00:00.000Z",
    });

    applyRetention({
      store,
      targets: [main],
      policy: loadRetentionPolicy({ RETENTION_RAW_EVENT_DAYS: "30" }),
      now: checkedAt,
    });
    assert.equal(store.getEntries({ ...scope, limit: 10, offset: 0 }).length, 0, "raw rows are gone");

    const results = await reconcileTarget({
      store,
      target: main,
      chainReader: chainReader({ balances: { [usdc]: 500n }, totalProposals: 1n }),
      now,
    });

    assert.ok(results.every((result) => result.status === "ok"));
    store.close();
  });

  it("records a chain read failure as an error rather than silent agreement", async () => {
    const store = createStore();

    const results = await reconcileTarget({
      store,
      target: main,
      chainReader: chainReader({ failBalance: true }),
      now,
    });

    const balance = results.find((result) => result.check === "token_balance");
    assert.equal(balance.status, "error");
    assert.equal(balance.drift, "unknown");
    assert.match(balance.details.error, /rpc unavailable/);
    store.close();
  });

  it("reconciles each target separately and stamps the run", async () => {
    const store = createStore();
    recordInflow(store, { eventId: "a", amount: "500", occurredAt: "2026-10-16T12:00:00.000Z" });

    await runReconciliation({
      store,
      targets: [main],
      chainReader: chainReader({ balances: { [usdc]: 500n } }),
      now,
    });
    await runReconciliation({
      store,
      targets: [other],
      chainReader: chainReader({ balances: { [xlm]: 42n } }),
      now,
    });

    assert.equal(store.getLatestReconciliations().length, 4, "two checks for each of two targets");
    assert.equal(store.getLatestReconciliations({ network: "pubnet" }).length, 2);
    assert.equal(
      store.getLatestReconciliations({ check: "token_balance" }).length,
      2,
      "filterable by check"
    );
    assert.equal(store.getState(scope, "last_reconciled_at"), checkedAt.toISOString());

    const pubnetBalance = store
      .getLatestReconciliations({ network: "pubnet", check: "token_balance" })
      .at(0);
    assert.equal(pubnetBalance.impliedBalance, "0");
    assert.equal(pubnetBalance.actualBalance, "42");
    assert.equal(pubnetBalance.status, "drift");
    store.close();
  });
});

describe("drift alerting", () => {
  it("alerts only on drift and errors, never on agreement", async () => {
    const store = createStore();
    recordInflow(store, { eventId: "a", amount: "500", occurredAt: "2026-10-16T12:00:00.000Z" });
    const logger = { error: () => {} };
    const alerter = createAlerter({ logger });

    await runReconciliation({
      store,
      targets: [main],
      chainReader: chainReader({ balances: { [usdc]: 500n }, totalProposals: 3n }),
      alerter,
      now,
    });

    assert.deepEqual(
      alerter.delivered.map(({ check, status }) => [check, status]),
      [["total_proposals", "drift"]]
    );
    store.close();
  });

  it("retries a failing webhook and gives up without throwing", async () => {
    const attemptsMade = [];
    const alerter = createAlerter({
      webhookUrl: "https://alerts.example/hook",
      attempts: 3,
      backoffMs: 0,
      logger: { error: () => {} },
      sleep: async () => {},
      fetchImpl: async () => {
        attemptsMade.push(Date.now());
        return { ok: false, status: 503 };
      },
    });

    const outcome = await alerter.alert({
      network: "testnet",
      contractId: main.contractId,
      check: "token_balance",
      subject: "USDC",
      status: "drift",
      impliedBalance: "500",
      actualBalance: "650",
      drift: "150",
    });

    assert.equal(attemptsMade.length, 3);
    assert.equal(outcome.delivered, false);
    assert.match(outcome.reason, /503/);
  });

  it("stops retrying once the webhook accepts the alert", async () => {
    let calls = 0;
    const alerter = createAlerter({
      webhookUrl: "https://alerts.example/hook",
      attempts: 3,
      backoffMs: 0,
      logger: { error: () => {} },
      sleep: async () => {},
      fetchImpl: async () => {
        calls += 1;
        return { ok: calls === 2, status: calls === 2 ? 200 : 500 };
      },
    });

    const outcome = await alerter.alert({
      network: "testnet",
      contractId: main.contractId,
      check: "token_balance",
      subject: "USDC",
      status: "drift",
      impliedBalance: "1",
      actualBalance: "2",
      drift: "1",
    });

    assert.deepEqual(outcome, { delivered: true, attempts: 2 });
    assert.equal(calls, 2);
  });
});

describe("drift metrics", () => {
  it("exposes drift, status and checkpoints per target in Prometheus format", async () => {
    const store = createStore();
    recordInflow(store, { eventId: "a", amount: "500", occurredAt: "2026-10-16T12:00:00.000Z" });
    store.setState(scope, "next_ledger", 1234);
    await runReconciliation({
      store,
      targets: [main],
      chainReader: chainReader({ balances: { [usdc]: 650n } }),
      now,
    });

    const metrics = renderMetrics(store, [main]);

    assert.match(metrics, /# TYPE accord_reconciliation_drift gauge/);
    assert.match(
      metrics,
      new RegExp(
        `accord_reconciliation_drift\\{network="testnet",contract_id="${main.contractId}",check="token_balance",subject="USDC"\\} 150`
      )
    );
    assert.match(metrics, /accord_reconciliation_status\{[^}]*subject="USDC"\} 0/);
    assert.match(metrics, /accord_reconciliation_status\{[^}]*subject="proposals"\} 1/);
    assert.match(metrics, /accord_indexer_next_ledger\{[^}]*\} 1234/);
    store.close();
  });
});
