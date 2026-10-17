import { createServer } from "node:http";
import {
  Contract,
  nativeToScVal,
  rpc,
  scValToNative,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { backfill, reindex, resolveFirstLedger } from "./commands.js";
import { DEFAULT_FINALITY_LAG, resolveFinalityLag } from "./finality.js";
import { indexEventBatch } from "./indexing.js";
import { openLedgerStore } from "./ledger.js";

const HELP = `Accord treasury indexer

Usage: node src/index.js [command] [options]

Commands:
  serve (default)  Start the indexer API and poll for new events
  backfill         Index history from the first relevant ledger to the present
  reindex          Clear the store and rebuild it from chain events

Options:
  --from <ledger>  First ledger to cover. Defaults to the oldest ledger the
                   RPC still retains.
  --to <ledger>    Last ledger to cover. Defaults to the final ledger, and is
                   always clamped to it - non-final ledgers are never indexed.
  --json           Emit machine-readable progress lines (backfill/reindex)
  -h, --help       Show this message

Environment:
  ACCORD_CONTRACT_ID   Accord contract address (required)
  XLM_TOKEN_ADDRESS    XLM token contract address (required)
  USDC_TOKEN_ADDRESS   USDC token contract address (required)
  SOROBAN_RPC_URL      Soroban RPC endpoint
  NETWORK_PASSPHRASE   Stellar network passphrase
  INDEXER_START_LEDGER First ledger for live indexing
  SIM_SOURCE           Funded account used to build simulations (serve only)
  LEDGER_FINALITY_LAG  Ledgers to hold back before treating one as final
                       (default ${DEFAULT_FINALITY_LAG})
  DATABASE_PATH        SQLite file (default ./data/treasury.sqlite)
`;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

function parseArgs(argv) {
  const args = { command: "serve", from: undefined, to: undefined, json: false, help: false };
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--from" || arg === "--to") {
      args[arg.slice(2)] = Number(argv[(index += 1)]);
    } else if (arg.startsWith("--from=") || arg.startsWith("--to=")) {
      args[arg.slice(2, arg.indexOf("="))] = Number(arg.slice(arg.indexOf("=") + 1));
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option ${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length > 1) throw new Error("expected at most one command");
  if (positionals[0]) args.command = positionals[0];
  for (const key of ["from", "to"]) {
    if (args[key] !== undefined && (!Number.isSafeInteger(args[key]) || args[key] < 1)) {
      throw new Error(`--${key} must be a positive integer`);
    }
  }
  if (!["serve", "backfill", "reindex"].includes(args.command)) {
    throw new Error(`unknown command ${args.command}`);
  }
  return args;
}

const rpcUrl = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const networkPassphrase = process.env.NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";
const treasuryAddress = required("ACCORD_CONTRACT_ID");
const finalityLag = resolveFinalityLag(process.env.LEDGER_FINALITY_LAG);

const tokens = [
  { name: "XLM", address: required("XLM_TOKEN_ADDRESS") },
  { name: "USDC", address: required("USDC_TOKEN_ADDRESS") },
];
const tokenAddresses = new Map(tokens.map(({ name, address }) => [name, address]));

function startLedgerFromEnv({ optional } = {}) {
  const raw = process.env.INDEXER_START_LEDGER?.trim();
  if (!raw) {
    if (optional) return undefined;
    throw new Error("INDEXER_START_LEDGER must be set");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("INDEXER_START_LEDGER must be a positive integer");
  }
  return value;
}

/** Throttled progress output so a long backfill reports without spamming logs. */
function createProgressReporter({ command, json, intervalMs = 2000 }) {
  let lastReport = 0;
  const render = (progress) => {
    const { start, end, ledger, events, pages, percent, complete, note, clamped } = progress;
    const range = Number.isFinite(end) ? `${start}-${end}` : `${start}+`;
    if (json) {
      return JSON.stringify({ command, start, end: Number.isFinite(end) ? end : null, ledger, events, pages, percent: Number(percent.toFixed(4)), complete, note: note ?? null, clamped: Boolean(clamped) });
    }
    const bar = `${(percent * 100).toFixed(1)}%`;
    const suffix = note ? ` (${note})` : "";
    return `[${command}] ${bar} ledger ${ledger}/${Number.isFinite(end) ? end : "?"} · range ${range} · events ${events} · pages ${pages}${suffix}`;
  };
  return (progress) => {
    const now = Date.now();
    if (!progress.complete && now - lastReport < intervalMs) return;
    lastReport = now;
    console.log(render(progress));
  };
}

async function runHistoryCommand({ command, args, store, stellar }) {
  const onProgress = createProgressReporter({ command, json: args.json });
  const run = command === "reindex" ? reindex : backfill;
  const result = await run({
    stellar,
    store,
    tokens,
    treasuryAddress,
    from: args.from,
    to: args.to,
    finalityLag,
    onProgress,
    // When no --from is given, the first ledger the RPC retains is the
    // practical genesis; a configured INDEXER_START_LEDGER takes precedence.
    fallbackStart: startLedgerFromEnv({ optional: true }) ?? 1,
  });
  if (result.nothingToDo) {
    console.log(`[${command}] nothing to do`);
    return result;
  }
  if (!result.complete) {
    // maxPages guard tripped; the checkpoint on disk makes this resumable.
    console.error(`[${command}] stopped early after ${result.pages} pages; re-run to resume`);
  }
  return result;
}

async function serve({ store, stellar }) {
  const simulationSource = required("SIM_SOURCE");
  const startLedger = startLedgerFromEnv();
  const pageLimit = 1000;
  let indexing = false;
  let reconciling = false;

  async function indexAvailableEvents() {
    if (indexing) return;
    indexing = true;
    try {
      await indexEventBatch({
        stellar,
        store,
        tokens,
        treasuryAddress,
        startLedger,
        pageLimit,
        finalityLag,
      });
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
        return sendJson(response, 200, {
          status: "ok",
          nextLedger: store.getState("next_ledger") ?? String(startLedger),
          latestLedger: Number(store.getState("last_seen_ledger") ?? 0) || null,
          finalityLag,
        });
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
      if (request.method === "GET" && url.pathname === "/events") {
        const topic = url.searchParams.get("topic");
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100), 1), 1000);
        const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);
        if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(offset)) {
          throw new Error("limit and offset must be non-negative integers");
        }
        const events = store.getAccordEvents({
          topic,
          from: parseDateParam(url.searchParams.get("from"), "from"),
          to: parseDateParam(url.searchParams.get("to"), "to"),
          limit,
          offset,
        });
        return sendJson(response, 200, { events });
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
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  const store = openLedgerStore(process.env.DATABASE_PATH ?? "./data/treasury.sqlite");
  const stellar = new rpc.Server(rpcUrl);

  if (args.command === "serve") {
    await serve({ store, stellar });
    return;
  }

  // History commands only need a starting point when one was not given: the
  // first ledger the RPC retains is the practical genesis for a backfill.
  await runHistoryCommand({ command: args.command, args, store, stellar });
  store.close();
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
