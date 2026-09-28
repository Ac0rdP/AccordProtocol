import { createServer } from "node:http";
import { resolve } from "node:path";
import {
  Contract,
  nativeToScVal,
  rpc,
  scValToNative,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { openLedgerStore } from "./ledger.js";
import { indexEventBatch } from "./indexing.js";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

const rpcUrl = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const networkPassphrase = process.env.NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";
const treasuryAddress = required("ACCORD_CONTRACT_ID");
const simulationSource = required("SIM_SOURCE");
const startLedger = Number(required("INDEXER_START_LEDGER"));
if (!Number.isSafeInteger(startLedger) || startLedger < 1) {
  throw new Error("INDEXER_START_LEDGER must be a positive integer");
}

const tokens = [
  { name: "XLM", address: required("XLM_TOKEN_ADDRESS") },
  { name: "USDC", address: required("USDC_TOKEN_ADDRESS") },
];
const tokenAddresses = new Map(tokens.map(({ name, address }) => [name, address]));
const store = openLedgerStore(process.env.DATABASE_PATH ?? "./data/treasury.sqlite");
const stellar = new rpc.Server(rpcUrl);
const pageLimit = 1000;
let indexing = false;
let reconciling = false;

async function indexAvailableEvents() {
  if (indexing) return;
  indexing = true;
  try {
    await indexEventBatch({ stellar, store, tokens, treasuryAddress, startLedger, pageLimit });
  } finally {
    indexing = false;
  }
}

async function readTokenBalance(account, tokenAddress) {
  const transaction = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase,
  })
    .addOperation(new Contract(tokenAddress).call(
      "balance",
      nativeToScVal(treasuryAddress, { type: "address" })
    ))
    .setTimeout(30)
    .build();

  const simulation = await stellar.simulateTransaction(transaction);
  if (!rpc.Api.isSimulationSuccess(simulation)) {
    throw new Error(simulation.error ?? `Failed to read ${tokenAddress} balance`);
  }
  return BigInt(scValToNative(simulation.result.retval));
}

async function reconcileBalances() {
  if (reconciling) return;
  reconciling = true;
  try {
    const account = await stellar.getAccount(simulationSource);
    for (const { name, address } of tokens) {
      const impliedBalance = BigInt(store.getBalance(name));
      const actualBalance = await readTokenBalance(account, address);
      const drift = actualBalance - impliedBalance;
      const result = {
        token: name,
        tokenAddress: address,
        checkedAt: new Date().toISOString(),
        impliedBalance: impliedBalance.toString(),
        actualBalance: actualBalance.toString(),
        drift: drift.toString(),
      };
      store.recordReconciliation(result);
      if (drift !== 0n) {
        console.error(`[reconciliation] ${name} drift: ${drift} stroops (actual - implied)`);
      }
    }
  } catch (error) {
    console.error("Treasury reconciliation failed:", error);
  } finally {
    reconciling = false;
  }
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function parseDateParam(value, name) {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${name} must be a valid date`);
  return parsed.toISOString();
}

const api = createServer((request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET" && url.pathname === "/health") {
      return sendJson(response, 200, { status: "ok", nextLedger: store.getState("next_ledger") ?? String(startLedger) });
    }
    if (request.method === "GET" && url.pathname === "/ledger") {
      const token = url.searchParams.get("token")?.toUpperCase();
      if (token && !tokenAddresses.has(token)) throw new Error("token must be XLM or USDC");
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100), 1), 1000);
      const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);
      if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(offset)) {
        throw new Error("limit and offset must be non-negative integers");
      }
      const entries = store.getEntries({
        token,
        from: parseDateParam(url.searchParams.get("from"), "from"),
        to: parseDateParam(url.searchParams.get("to"), "to"),
        limit,
        offset,
      });
      return sendJson(response, 200, { entries });
    }
    if (request.method === "GET" && url.pathname === "/reconciliation") {
      return sendJson(response, 200, { results: store.getLatestReconciliations() });
    }
    return sendJson(response, 404, { error: "not found" });
  } catch (error) {
    return sendJson(response, 400, { error: error.message });
  }
});

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8787);
api.listen(port, host, () => {
  console.log(`Treasury indexer API listening on http://${host}:${port}`);
  void indexAvailableEvents()
    .catch((error) => console.error("Treasury event indexing failed:", error))
    .finally(() => void reconcileBalances());
});

const indexTimer = setInterval(() => {
  void indexAvailableEvents().catch((error) => console.error("Treasury event indexing failed:", error));
}, Number(process.env.INDEX_INTERVAL_MS ?? 5000));
const reconcileTimer = setInterval(() => void reconcileBalances(), Number(process.env.RECONCILE_INTERVAL_MS ?? 60000));

function shutdown() {
  clearInterval(indexTimer);
  clearInterval(reconcileTimer);
  api.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);