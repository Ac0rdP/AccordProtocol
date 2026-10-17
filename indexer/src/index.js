import {
  Contract,
  nativeToScVal,
  rpc,
  scValToNative,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { createApi } from "./api.js";
import { backfill, reindex, resolveFirstLedger } from "./commands.js";
import { DEFAULT_FINALITY_LAG, resolveFinalityLag } from "./finality.js";
import { createReadiness, DEFAULT_READY_MAX_STALENESS_MS } from "./health.js";
import { indexEventBatch } from "./indexing.js";
import { createIndexerMetrics, recordBatchSuccess } from "./metrics.js";
import { openStore, resolveStoreConfig } from "./store/index.js";
import { createWebhookDispatcher, loadSubscriptions } from "./webhooks.js";

const HELP = `Accord treasury indexer

Usage: node src/index.js [command] [options]

Commands:
  serve (default)  Start the indexer API and poll for new events
  backfill         Index history from the first relevant ledger to the present
  reindex          Clear the store and rebuild it from chain events
  webhooks-requeue Move dead-lettered webhook deliveries back to pending

Options:
  --from <ledger>  First ledger to cover. Defaults to the oldest ledger the
                   RPC still retains.
  --to <ledger>    Last ledger to cover. Defaults to the final ledger, and is
                   always clamped to it - non-final ledgers are never indexed.
  --json           Emit machine-readable progress lines (backfill/reindex)
  --subscription <id>  Limit webhooks-requeue to one subscription
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
  STORE_BACKEND        sqlite (default) or postgres
  DATABASE_PATH        SQLite file (default ./data/treasury.sqlite)
  DATABASE_URL         Postgres connection URL (STORE_BACKEND=postgres)
  DATABASE_POOL_MAX    Postgres pool size (default 10)
  DATABASE_AUTO_MIGRATE  Apply Postgres migrations on start (default true);
                       run them separately with "npm run migrate"
  WEBHOOK_SUBSCRIPTIONS_FILE  JSON file of webhook subscriptions
  READY_MAX_STALENESS_MS  Max age of the last good batch for /readyz
                       (default ${DEFAULT_READY_MAX_STALENESS_MS})
`;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

function parseArgs(argv) {
  const args = { command: "serve", from: undefined, to: undefined, json: false, help: false, subscription: undefined };
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--subscription") {
      args.subscription = argv[(index += 1)];
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
  if (!["serve", "backfill", "reindex", "webhooks-requeue"].includes(args.command)) {
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
  const indexIntervalMs = Number(process.env.INDEX_INTERVAL_MS ?? 5000);
  let indexing = false;
  let reconciling = false;

  const metrics = createIndexerMetrics();
  const readiness = createReadiness({
    store,
    // A healthy loop reports every INDEX_INTERVAL_MS; allow several missed beats.
    maxStalenessMs: Number(
      process.env.READY_MAX_STALENESS_MS ?? Math.max(DEFAULT_READY_MAX_STALENESS_MS, indexIntervalMs * 6)
    ),
  });
  const subscriptions = loadSubscriptions();
  const webhooks = createWebhookDispatcher({
    store,
    subscriptions,
    metrics,
    maxAttempts: Number(process.env.WEBHOOK_MAX_ATTEMPTS ?? 8),
    backoffBaseMs: Number(process.env.WEBHOOK_BACKOFF_BASE_MS ?? 5000),
    backoffMaxMs: Number(process.env.WEBHOOK_BACKOFF_MAX_MS ?? 3_600_000),
    timeoutMs: Number(process.env.WEBHOOK_TIMEOUT_MS ?? 10_000),
  });

  async function indexAvailableEvents() {
    if (indexing) return;
    indexing = true;
    const startedAt = performance.now();
    try {
      const result = await indexEventBatch({
        stellar,
        store,
        tokens,
        treasuryAddress,
        startLedger,
        pageLimit,
        finalityLag,
      });
      const indexedLedger = Number((await store.getState("next_ledger")) ?? startLedger) - 1;
      recordBatchSuccess(metrics, result, indexedLedger);
      readiness.markSuccess();
    } catch (error) {
      metrics.errors.inc({ stage: "index" });
      metrics.batches.inc({ outcome: "error" });
      readiness.markFailure(error);
      throw error;
    } finally {
      metrics.batchDuration.observe((performance.now() - startedAt) / 1000);
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
        const impliedBalance = BigInt(await store.getBalance(name));
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
        await store.recordReconciliation(result);
        if (drift !== 0n) {
          console.error(`[reconciliation] ${name} drift: ${drift} stroops (actual - implied)`);
        }
      }
    } catch (error) {
      metrics.errors.inc({ stage: "reconcile" });
      console.error("Treasury reconciliation failed:", error);
    } finally {
      reconciling = false;
    }
  }

  const api = createApi({ store, readiness, metrics, startLedger, finalityLag, tokenAddresses });

  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? 8787);
  api.listen(port, host, () => {
    console.log(`Treasury indexer API listening on http://${host}:${port} (${store.backend} store)`);
    if (subscriptions.length > 0) console.log(`Webhook delivery enabled for ${subscriptions.length} subscription(s)`);
    void indexAvailableEvents()
      .catch((error) => console.error("Treasury event indexing failed:", error))
      .finally(() => void reconcileBalances());
  });
  webhooks.start(Number(process.env.WEBHOOK_POLL_INTERVAL_MS ?? 2000));

  const indexTimer = setInterval(() => {
    void indexAvailableEvents().catch((error) => console.error("Treasury event indexing failed:", error));
  }, indexIntervalMs);
  const reconcileTimer = setInterval(() => void reconcileBalances(), Number(process.env.RECONCILE_INTERVAL_MS ?? 60000));

  function shutdown() {
    clearInterval(indexTimer);
    clearInterval(reconcileTimer);
    webhooks.stop();
    api.close(() => {
      store.close().finally(() => process.exit(0));
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

  const store = await openStore(resolveStoreConfig());

  if (args.command === "webhooks-requeue") {
    const requeued = await store.requeueDeadWebhookDeliveries({
      subscriptionId: args.subscription,
      now: new Date().toISOString(),
    });
    console.log(`Requeued ${requeued} dead-lettered deliveries`);
    await store.close();
    return;
  }

  const stellar = new rpc.Server(rpcUrl);

  if (args.command === "serve") {
    await serve({ store, stellar });
    return;
  }

  // History commands only need a starting point when one was not given: the
  // first ledger the RPC retains is the practical genesis for a backfill.
  await runHistoryCommand({ command: args.command, args, store, stellar });
  await store.close();
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
