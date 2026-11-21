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
import { createLagMonitor } from "./lag-monitor.js";
import { createReadiness, DEFAULT_READY_MAX_STALENESS_MS } from "./health.js";
import { indexEventBatch } from "./indexing.js";
import {
  formatReplayEvent,
  openReplayStore,
  readLiveCheckpoint,
  replay,
  replayEventRecord,
  resolveReplayWindow,
} from "./replay.js";
import { createIndexerMetrics, recordBatchSuccess } from "./metrics.js";
import { openStore, resolveStoreConfig } from "./store/index.js";
import { createWebhookDispatcher, loadSubscriptions } from "./webhooks.js";
import { createNotificationDispatcher } from "./notifications.js";
import { createSubscriptionManager } from "./subscriptions.js";
import {
  resolveApiKeysConfig,
  resolveEventValidationConfig,
  resolveGraphQLConfig,
  resolveLeaderElectionConfig,
  resolveStreamExportersConfig,
  resolveWarehouseConfig,
  resolveWebhookDashboardConfig,
  resolveBackfillConfig,
  resolveAnomalyConfig,
  resolveLagMonitorConfig,
  resolveRunwayConfig,
} from "./config.js";
import { createApiKeyService } from "./api-keys.js";
import { createEventValidator, QUARANTINE_REASONS, reprocessQuarantine } from "./event-validation.js";
import { createHolderId, createLeaderElection, createStaticLeader } from "./leader-election.js";
import { createStreamDispatcher } from "./stream-exporters.js";
import { createWarehouseExportManager } from "./warehouse-connectors.js";

const HELP = `Accord treasury indexer

Usage: node src/index.js [command] [options]

Commands:
  serve (default)  Start the indexer API and poll for new events
  backfill         Index history from the first relevant ledger to the present
  reindex          Clear the store and rebuild it from chain events
  replay           Replay a ledger range into an isolated store and print every
                   event; the live store is never written
  webhooks-requeue Move dead-lettered webhook deliveries back to pending
  notifications-requeue  Move dead-lettered notification deliveries back to pending
  quarantine-reprocess   Re-validate quarantined contract events and release the
                   ones that are valid now (--topic / --reason narrow it)
  quarantine-discard     Mark one quarantined event as discarded (--id <n>)

Options:
  --from <ledger>  First ledger to cover. Defaults to the oldest ledger the
                   RPC still retains.
  --to <ledger>    Last ledger to cover. Defaults to the final ledger, and is
                   always clamped to it - non-final ledgers are never indexed.
  --json           Emit machine-readable progress lines (backfill/reindex/replay)
  --before-checkpoint <n>  replay: the n ledgers before the live checkpoint
  --after-checkpoint <n>   replay: the n ledgers from the live checkpoint on
  --checkpoint <ledger>    replay: use this checkpoint instead of reading the
                   live store's next_ledger
  --replay-store <path>    replay: keep the isolated SQLite store at this path
                   (default: in memory, discarded on exit). Never the live DB.
  --subscription <id>  Limit webhooks-requeue to one subscription
  --destination <id>   Limit notifications-requeue to one destination
  --id <n>         quarantine-discard: the quarantined event to discard
  --topic <name>   quarantine-reprocess: only this event topic
  --reason <code>  quarantine-reprocess: only this quarantine reason
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
  EMAIL_API_URL        HTTP endpoint for the email transport used by "email"
                       notification destinations (accepts {from,to,subject,text})
  EMAIL_API_KEY        Bearer token sent to EMAIL_API_URL
  EMAIL_FROM           "From" address sent to EMAIL_API_URL
  NOTIFICATION_POLL_INTERVAL_MS  Notification worker poll interval (default 2000)
  NOTIFICATION_MAX_ATTEMPTS      Attempts before dead-lettering (default 8)
  WEBHOOK_DASHBOARD_ENABLED  Serve the webhook delivery dashboard at /ops/webhooks
                       (default true; read-only)
  OPS_ADMIN_TOKEN      Bearer token (16+ chars) that enables the dashboard's
                       replay/retry controls (default unset = controls disabled)
  WEBHOOK_DASHBOARD_PAGE_SIZE  Deliveries per dashboard page (default 50)
  API_KEYS_ENABLED     Require an API key (with scope and quota) for /ledger, /events,
                       /reconciliation and the subscriptions stream (default false)
  API_KEYS_DEFAULT_QUOTA / API_KEYS_DEFAULT_WINDOW_SECONDS  Quota for new keys
                       (default 1000 requests per 3600 seconds)
  API_KEYS_ROTATION_GRACE_SECONDS  How long a rotated-out secret keeps working (default 86400)
  API_KEYS_USAGE_RETENTION_DAYS  How long quota counters are kept (default 30)
  EVENT_VALIDATION_MODE  enforce (default: quarantine events that fail schema
                       validation), warn (index but report) or off
  EVENT_SCHEMA_STRICT  Treat fields outside the schema as violations (default true)
  EVENT_ALLOW_UNVERSIONED  Accept events from pre-versioning deployments (default true)
  INDEXER_LEADER_ELECTION_ENABLED  Run redundant indexers with automatic
                       failover (default false; needs STORE_BACKEND=postgres)
  INDEXER_REGION       Region label shown in status output (default empty)
  INDEXER_INSTANCE_ID  Unique id of this instance (default host-pid-random)
  INDEXER_LEASE_NAME   Lease contended for (default indexer-leader)
  INDEXER_LEASE_TTL_MS Lease lifetime without renewal (default 15000)
  INDEXER_LEASE_RENEW_MS  Renewal cadence, at most half the TTL (default 5000)
`;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

function parseArgs(argv) {
  const args = {
    command: "serve",
    from: undefined,
    to: undefined,
    json: false,
    help: false,
    subscription: undefined,
    destination: undefined,
    topic: undefined,
    reason: undefined,
    id: undefined,
    beforeCheckpoint: undefined,
    afterCheckpoint: undefined,
    checkpoint: undefined,
    replayStore: undefined,
  };
  const numericOptions = {
    "--from": "from",
    "--to": "to",
    "--before-checkpoint": "beforeCheckpoint",
    "--after-checkpoint": "afterCheckpoint",
    "--checkpoint": "checkpoint",
    "--id": "id",
  };
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--subscription") {
      args.subscription = argv[(index += 1)];
    } else if (arg === "--destination") {
      args.destination = argv[(index += 1)];
    } else if (arg === "--topic") {
      args.topic = argv[(index += 1)];
    } else if (arg === "--reason") {
      args.reason = argv[(index += 1)];
    } else if (arg === "--replay-store") {
      args.replayStore = argv[(index += 1)];
    } else if (arg in numericOptions) {
      args[numericOptions[arg]] = Number(argv[(index += 1)]);
    } else if (arg.includes("=") && arg.slice(0, arg.indexOf("=")) in numericOptions) {
      args[numericOptions[arg.slice(0, arg.indexOf("="))]] = Number(arg.slice(arg.indexOf("=") + 1));
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option ${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length > 1) throw new Error("expected at most one command");
  if (positionals[0]) args.command = positionals[0];
  for (const [flag, key] of Object.entries(numericOptions)) {
    if (args[key] !== undefined && (!Number.isSafeInteger(args[key]) || args[key] < 1)) {
      throw new Error(`${flag} must be a positive integer`);
    }
  }
  if (!["serve", "backfill", "reindex", "replay", "webhooks-requeue", "notifications-requeue", "quarantine-reprocess", "quarantine-discard"].includes(args.command)) {
    throw new Error(`unknown command ${args.command}`);
  }
  return args;
}

const rpcUrl = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const networkPassphrase = process.env.NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";
const treasuryAddress = required("ACCORD_CONTRACT_ID");
const finalityLag = resolveFinalityLag(process.env.LEDGER_FINALITY_LAG);

const validationConfig = resolveEventValidationConfig();
if (validationConfig.modeRejected) {
  console.warn(`[validation] EVENT_VALIDATION_MODE=${process.env.EVENT_VALIDATION_MODE} is not one of off, warn, enforce; using enforce`);
}
const validator = createEventValidator(validationConfig);

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
    validator,
    // When no --from is given, the first ledger the RPC retains is the
    // practical genesis; a configured INDEXER_START_LEDGER takes precedence.
    fallbackStart: startLedgerFromEnv({ optional: true }) ?? 1,
    parallel: command === "backfill" ? resolveBackfillConfig() : null,
  });
  if (result.nothingToDo) {
    console.log(`[${command}] nothing to do`);
    return result;
  }
  if (!result.complete) {
    // maxPages guard tripped; the checkpoint on disk makes this resumable.
    const failed = result.failedShards?.length
      ? ` (${result.failedShards.length} shard(s) failed: ${result.failedShards.map((shard) => `#${shard.index} ${shard.start}-${shard.end}`).join(", ")})`
      : "";
    console.error(`[${command}] stopped early after ${result.pages} pages${failed}; re-run to resume`);
  }
  return result;
}

/**
 * Replays a ledger range into a store of its own and prints each event.
 * The live store is at most read (for its checkpoint) and never written.
 */
async function runReplay({ args, stellar, storeConfig }) {
  const needsCheckpoint = args.beforeCheckpoint !== undefined || args.afterCheckpoint !== undefined;
  const checkpoint = args.checkpoint ?? (needsCheckpoint ? await readLiveCheckpoint(storeConfig) : undefined);
  const window = resolveReplayWindow({ ...args, checkpoint });
  const replayStore = openReplayStore({
    path: args.replayStore,
    liveDatabasePath: storeConfig.backend === "sqlite" ? storeConfig.databasePath : undefined,
  });
  const print = (line) => console.log(args.json ? JSON.stringify(line) : line);

  try {
    const result = await replay({
      stellar,
      replayStore,
      tokens,
      treasuryAddress,
      from: window.from,
      to: window.to,
      finalityLag,
      validator,
      onEvent: (detail) => print(args.json ? replayEventRecord(detail) : formatReplayEvent(detail)),
    });
    const summary = {
      kind: "summary",
      start: result.start,
      end: result.end,
      clamped: result.clamped,
      checkpoint: window.checkpoint,
      eventsSeen: result.eventsSeen ?? 0,
      eventsIndexed: result.eventsIndexed,
      pages: result.pages,
      balances: result.balances,
      isolatedStore: args.replayStore ?? "in-memory",
    };
    print(args.json ? summary : `[replay] ledgers ${summary.start}-${summary.end}${summary.clamped ? " (end clamped to the final ledger)" : ""}: ${summary.eventsSeen} event(s) seen, ${summary.eventsIndexed} applied to the isolated store (${summary.isolatedStore}); live store untouched`);
    return result;
  } finally {
    await replayStore.close();
  }
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
  const lagMonitor = createLagMonitor({
    store,
    metrics,
    config: resolveLagMonitorConfig(process.env, finalityLag),
    finalityLag,
    onAlert: ({ check, level, previous, value, threshold }) => {
      const log = level === "ok" ? console.log : console.warn;
      log(`[lag] ${check} ${previous} -> ${level} (value ${value}, threshold ${threshold})`);
    },
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
  const notifications = createNotificationDispatcher({
    store,
    metrics,
    maxAttempts: Number(process.env.NOTIFICATION_MAX_ATTEMPTS ?? 8),
    backoffBaseMs: Number(process.env.NOTIFICATION_BACKOFF_BASE_MS ?? 5000),
    backoffMaxMs: Number(process.env.NOTIFICATION_BACKOFF_MAX_MS ?? 3_600_000),
    timeoutMs: Number(process.env.NOTIFICATION_TIMEOUT_MS ?? 10_000),
  });
  const graphqlConfig = resolveGraphQLConfig();
  const graphqlSubscriptions = graphqlConfig.enabled
    ? createSubscriptionManager({
        store,
        metrics,
        keepAliveMs: graphqlConfig.keepAliveMs,
        maxSubscriptionsPerClient: graphqlConfig.maxSubscriptionsPerClient,
        replayMaxEvents: graphqlConfig.replayMaxEvents,
      })
    : null;

  const streamConfig = resolveStreamExportersConfig();
  const streamDispatcher = createStreamDispatcher({
    store,
    config: streamConfig,
    metrics,
  });

  const warehouseConfig = resolveWarehouseConfig();
  const warehouseManager = createWarehouseExportManager({
    store,
    config: warehouseConfig,
    metrics,
  });

  // Multi-region failover: one instance holds the lease and does all the
  // writing (ingestion, reconciliation, outbound delivery); the rest stand by
  // and take over when the lease lapses. With failover off, this instance is
  // always the leader and nothing changes.
  const leaderConfig = resolveLeaderElectionConfig();
  const workerPollMs = {
    webhooks: Number(process.env.WEBHOOK_POLL_INTERVAL_MS ?? 2000),
    notifications: Number(process.env.NOTIFICATION_POLL_INTERVAL_MS ?? 2000),
  };
  let workersRunning = false;

  function startLeaderWorkers() {
    if (workersRunning) return;
    workersRunning = true;
    void streamDispatcher.start();
    void warehouseManager.start();
    webhooks.start(workerPollMs.webhooks);
    notifications.start(workerPollMs.notifications);
  }

  async function stopLeaderWorkers() {
    if (!workersRunning) return;
    workersRunning = false;
    webhooks.stop();
    notifications.stop();
    await streamDispatcher.close();
    await warehouseManager.close();
  }

  const election = leaderConfig.enabled
    ? createLeaderElection({
        store,
        metrics,
        holderId: leaderConfig.instanceId || createHolderId({ region: leaderConfig.region }),
        region: leaderConfig.region,
        name: leaderConfig.leaseName,
        ttlMs: leaderConfig.leaseTtlMs,
        renewIntervalMs: leaderConfig.renewIntervalMs,
        onElected: ({ holderId, lease }) => {
          console.log(`[leader] ${holderId} is now the leader (fencing token ${lease?.fencingToken})`);
          readiness.clearStandby();
          startLeaderWorkers();
          void indexAvailableEvents()
            .catch((error) => console.error("Treasury event indexing failed:", error))
            .finally(() => void reconcileBalances());
        },
        onDemoted: async ({ holderId, lease }) => {
          console.log(`[leader] ${holderId} stepped down; current leader: ${lease?.holderId ?? "none"}`);
          readiness.markStandby(lease ? { holderId: lease.holderId, region: lease.region } : null);
          await stopLeaderWorkers();
        },
      })
    : createStaticLeader({ region: leaderConfig.region });
  metrics.isLeader.set(leaderConfig.enabled ? 0 : 1);
  if (leaderConfig.enabled) {
    if (store.backend !== "postgres") {
      console.warn("[leader] failover is enabled on a non-Postgres store; instances only coordinate if they share this database");
    }
    // Until the first election round resolves we are a standby, not a stale leader.
    readiness.markStandby(null);
  }

  async function indexAvailableEvents() {
    // Keeps checkpoint age growing even while a batch is failing or hung.
    await lagMonitor.refresh();
    if (indexing || !election.isLeader()) return;
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
        subscriptions: graphqlSubscriptions,
        validator,
        onEvent: (event) => streamDispatcher.publish(event),
      });
      const indexedLedger = Number((await store.getState("next_ledger")) ?? startLedger) - 1;
      recordBatchSuccess(metrics, result, indexedLedger);
      await refreshQuarantineBacklog();
      await lagMonitor.observe({ latestLedger: result.latestLedger, indexedLedger });
      // A batch that finished after the lease was lost is still safe (writes are
      // idempotent), but it must not make a standby look like it is ingesting.
      if (election.isLeader()) readiness.markSuccess();
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

  async function refreshQuarantineBacklog() {
    const { byReason } = await store.countQuarantinedEvents();
    for (const reason of QUARANTINE_REASONS) metrics.quarantineBacklog.set({ reason }, byReason[reason] ?? 0);
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
    if (reconciling || !election.isLeader()) return;
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

  const webhookDashboard = resolveWebhookDashboardConfig();
  if (webhookDashboard.adminTokenRejected) {
    console.warn("[ops] OPS_ADMIN_TOKEN is shorter than 16 characters and was ignored; webhook retry controls are disabled");
  }
  const apiKeyConfig = resolveApiKeysConfig();
  const apiKeys = createApiKeyService({ store, config: apiKeyConfig, metrics });
  if (apiKeyConfig.enabled && !webhookDashboard.adminToken) {
    console.warn("[api-keys] API_KEYS_ENABLED is on but OPS_ADMIN_TOKEN is not set: keys cannot be issued over HTTP");
  }
  const api = createApi({
    store,
    readiness,
    metrics,
    startLedger,
    finalityLag,
    tokenAddresses,
    subscriptions: graphqlSubscriptions,
    election,
    webhookDashboard,
    webhookSubscriptions: subscriptions,
    validator,
    apiKeys,
    apiKeysEnabled: apiKeyConfig.enabled,
    lagMonitor,
    runwayConfig: resolveRunwayConfig(),
    anomalyConfig: resolveAnomalyConfig(),
  });

  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? 8787);
  api.listen(port, host, () => {
    console.log(`Treasury indexer API listening on http://${host}:${port} (${store.backend} store)`);
    if (subscriptions.length > 0) console.log(`Webhook delivery enabled for ${subscriptions.length} subscription(s)`);
    if (leaderConfig.enabled) {
      election.start();
    } else {
      startLeaderWorkers();
      void indexAvailableEvents()
        .catch((error) => console.error("Treasury event indexing failed:", error))
        .finally(() => void reconcileBalances());
    }
  });

  const indexTimer = setInterval(() => {
    void indexAvailableEvents().catch((error) => console.error("Treasury event indexing failed:", error));
  }, indexIntervalMs);
  const pruneTimer = setInterval(() => {
    void apiKeys.prune().catch((error) => console.error("API key usage cleanup failed:", error));
  }, 3_600_000);
  pruneTimer.unref?.();
  const reconcileTimer = setInterval(() => void reconcileBalances(), Number(process.env.RECONCILE_INTERVAL_MS ?? 60000));

  async function shutdown() {
    clearInterval(indexTimer);
    clearInterval(reconcileTimer);
    clearInterval(pruneTimer);
    graphqlSubscriptions?.close?.();
    // Release the lease first so a standby takes over without waiting for the TTL.
    await election.stop().catch((error) => console.error("Leader release failed:", error));
    await stopLeaderWorkers().catch((error) => console.error("Worker shutdown failed:", error));
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

  const storeConfig = resolveStoreConfig();

  // Replay never opens the live store for writing: it reads the checkpoint and
  // otherwise works only against its own isolated store.
  if (args.command === "replay") {
    await runReplay({ args, stellar: new rpc.Server(rpcUrl), storeConfig });
    return;
  }

  const store = await openStore(storeConfig);

  if (args.command === "webhooks-requeue") {
    const requeued = await store.requeueDeadWebhookDeliveries({
      subscriptionId: args.subscription,
      now: new Date().toISOString(),
    });
    console.log(`Requeued ${requeued} dead-lettered deliveries`);
    await store.close();
    return;
  }

  if (args.command === "notifications-requeue") {
    const requeued = await store.requeueDeadNotificationDeliveries({
      destinationId: args.destination,
      now: new Date().toISOString(),
    });
    console.log(`Requeued ${requeued} dead-lettered notification deliveries`);
    await store.close();
    return;
  }

  if (args.command === "quarantine-reprocess") {
    if (args.reason && !QUARANTINE_REASONS.includes(args.reason)) {
      throw new Error(`--reason must be one of: ${QUARANTINE_REASONS.join(", ")}`);
    }
    const result = await reprocessQuarantine({
      store, treasuryAddress, validator, topic: args.topic, reason: args.reason,
    });
    console.log(`Examined ${result.examined} quarantined event(s): released ${result.released}, still quarantined ${result.stillQuarantined}`);
    await store.close();
    return;
  }

  if (args.command === "quarantine-discard") {
    if (args.id === undefined) throw new Error("quarantine-discard needs --id <n>");
    const discarded = await store.resolveQuarantinedEvent({ id: args.id, status: "discarded", now: new Date().toISOString() });
    console.log(discarded ? `Discarded quarantined event ${args.id}` : `No quarantined event ${args.id} to discard`);
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
