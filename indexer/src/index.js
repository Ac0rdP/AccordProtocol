import { createServer } from "node:http";
import { rpc } from "@stellar/stellar-sdk";
import { loadTargets, networkFromPassphrase } from "./config.js";
import { openLedgerStore } from "./ledger.js";
import { indexEventBatch } from "./indexing.js";
import {
  createAlerter,
  createChainReader,
  renderMetrics,
  runReconciliation,
} from "./reconciliation.js";
import { applyRetention, loadRetentionPolicy } from "./retention.js";

const targets = loadTargets();
const policy = loadRetentionPolicy();
const store = openLedgerStore(process.env.DATABASE_PATH ?? "./data/treasury.sqlite", {
  legacyTarget: process.env.ACCORD_CONTRACT_ID?.trim()
    ? {
        network: networkFromPassphrase(
          process.env.NETWORK_PASSPHRASE?.trim() ?? "Test SDF Network ; September 2015"
        ),
        contractId: process.env.ACCORD_CONTRACT_ID.trim(),
      }
    : undefined,
});

const alerter = createAlerter({ webhookUrl: process.env.ALERT_WEBHOOK_URL?.trim() || undefined });

// One RPC client and chain reader per target, because targets may sit on
// different networks with different endpoints.
const runtimes = new Map(
  targets.map((target) => {
    // A standalone or local network is reached over plain HTTP, which the SDK
    // only allows when asked explicitly.
    const stellar = new rpc.Server(target.rpcUrl, {
      allowHttp: target.rpcUrl.startsWith("http://"),
    });
    return [
      target.key,
      {
        target,
        stellar,
        chainReader: createChainReader({
          stellar,
          networkPassphrase: target.networkPassphrase,
          simulationSource: target.simulationSource,
        }),
      },
    ];
  })
);

const knownTokens = new Set(targets.flatMap(({ tokens }) => tokens.map(({ name }) => name)));
let indexing = false;
let reconciling = false;
let retaining = false;

async function indexAvailableEvents() {
  if (indexing) return;
  indexing = true;
  try {
    for (const { target, stellar } of runtimes.values()) {
      try {
        await indexEventBatch({ stellar, store, target });
      } catch (error) {
        console.error(`Treasury event indexing failed for ${target.key}:`, error);
      }
    }
  } finally {
    indexing = false;
  }
}

async function reconcileTargets(selected = targets) {
  if (reconciling) return { skipped: true, reason: "a reconciliation run is already in progress" };
  reconciling = true;
  try {
    const chainReaders = selected.map((target) => runtimes.get(target.key));
    const results = [];
    for (const runtime of chainReaders) {
      results.push(
        ...(await runReconciliation({
          store,
          targets: [runtime.target],
          chainReader: runtime.chainReader,
          alerter,
        }))
      );
    }
    return { skipped: false, results };
  } catch (error) {
    console.error("Treasury reconciliation failed:", error);
    return { skipped: false, error: String(error.message ?? error) };
  } finally {
    reconciling = false;
  }
}

function runRetention(selected = targets) {
  if (!policy.enabled) return { skipped: true, reason: "no retention window is configured" };
  if (retaining) return { skipped: true, reason: "a retention run is already in progress" };
  retaining = true;
  try {
    return { skipped: false, runs: applyRetention({ store, targets: selected, policy }) };
  } finally {
    retaining = false;
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

/** Resolves the `network` and `contract` query parameters against configured targets. */
function parseScope(url) {
  const network = url.searchParams.get("network")?.trim() || undefined;
  const contractId = url.searchParams.get("contract")?.trim() || undefined;
  const matches = targets.filter(
    (target) =>
      (!network || target.network === network) && (!contractId || target.contractId === contractId)
  );
  if ((network || contractId) && matches.length === 0) {
    throw new Error("no configured target matches the requested network and contract");
  }
  return { network, contractId, matches };
}

function parsePaging(url) {
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100), 1), 1000);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);
  if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(offset)) {
    throw new Error("limit and offset must be non-negative integers");
  }
  return { limit, offset };
}

const api = createServer((request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");

    if (request.method === "GET" && url.pathname === "/health") {
      return sendJson(response, 200, {
        status: "ok",
        targets: targets.map((target) => ({
          id: target.id,
          network: target.network,
          contractId: target.contractId,
          nextLedger:
            store.getState({ network: target.network, contractId: target.contractId }, "next_ledger") ??
            String(target.startLedger),
          lastIndexedAt: store.getState(
            { network: target.network, contractId: target.contractId },
            "last_indexed_at"
          ),
        })),
      });
    }

    if (request.method === "GET" && url.pathname === "/targets") {
      return sendJson(response, 200, {
        targets: targets.map(({ id, network, contractId, rpcUrl, startLedger, tokens }) => ({
          id,
          network,
          contractId,
          rpcUrl,
          startLedger,
          tokens,
        })),
      });
    }

    if (request.method === "GET" && url.pathname === "/ledger") {
      const { network, contractId } = parseScope(url);
      const token = url.searchParams.get("token")?.toUpperCase();
      if (token && !knownTokens.has(token)) {
        throw new Error(`token must be one of: ${[...knownTokens].sort().join(", ")}`);
      }
      const { limit, offset } = parsePaging(url);
      const entries = store.getEntries({
        network,
        contractId,
        token,
        from: parseDateParam(url.searchParams.get("from"), "from"),
        to: parseDateParam(url.searchParams.get("to"), "to"),
        limit,
        offset,
      });
      return sendJson(response, 200, { entries });
    }

    if (request.method === "GET" && url.pathname === "/events") {
      const { network, contractId } = parseScope(url);
      const { limit, offset } = parsePaging(url);
      const events = store.getAccordEvents({
        network,
        contractId,
        topic: url.searchParams.get("topic"),
        from: parseDateParam(url.searchParams.get("from"), "from"),
        to: parseDateParam(url.searchParams.get("to"), "to"),
        limit,
        offset,
      });
      return sendJson(response, 200, { events });
    }

    if (request.method === "GET" && url.pathname === "/balances") {
      const { network, contractId } = parseScope(url);
      return sendJson(response, 200, { balances: store.getBalances({ network, contractId }) });
    }

    if (request.method === "GET" && url.pathname === "/aggregates") {
      const { network, contractId } = parseScope(url);
      return sendJson(response, 200, {
        aggregates: store.getDailyAggregates({
          network,
          contractId,
          token: url.searchParams.get("token")?.toUpperCase(),
          fromDay: url.searchParams.get("fromDay") ?? undefined,
          toDay: url.searchParams.get("toDay") ?? undefined,
        }),
      });
    }

    if (request.method === "GET" && url.pathname === "/reconciliation") {
      const { network, contractId } = parseScope(url);
      return sendJson(response, 200, {
        results: store.getLatestReconciliations({
          network,
          contractId,
          check: url.searchParams.get("check") ?? undefined,
        }),
      });
    }

    if (request.method === "POST" && url.pathname === "/reconciliation/run") {
      const { matches } = parseScope(url);
      return void reconcileTargets(matches).then((outcome) =>
        sendJson(response, outcome.skipped ? 409 : 200, outcome)
      );
    }

    if (request.method === "GET" && url.pathname === "/retention") {
      const { network, contractId } = parseScope(url);
      return sendJson(response, 200, {
        policy: {
          rawEventDays: policy.rawEventDays,
          aggregateDays: policy.aggregateDays,
          reconciliationDays: policy.reconciliationDays,
          archiveDir: policy.archiveDir,
          intervalMs: policy.intervalMs,
          enabled: policy.enabled,
        },
        runs: store.getRetentionRuns({ network, contractId }),
      });
    }

    if (request.method === "POST" && url.pathname === "/retention/run") {
      const { matches } = parseScope(url);
      const outcome = runRetention(matches);
      return sendJson(response, outcome.skipped ? 409 : 200, outcome);
    }

    if (request.method === "GET" && url.pathname === "/metrics") {
      response.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
      return response.end(renderMetrics(store, targets));
    }

    return sendJson(response, 404, { error: "not found" });
  } catch (error) {
    return sendJson(response, 400, { error: error.message });
  }
});

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8787);
api.listen(port, host, () => {
  console.log(
    `Treasury indexer API listening on http://${host}:${port} for ${targets.length} target(s): ` +
      targets.map((target) => target.key).join(", ")
  );
  void indexAvailableEvents()
    .catch((error) => console.error("Treasury event indexing failed:", error))
    .finally(() => void reconcileTargets());
});

const indexTimer = setInterval(() => {
  void indexAvailableEvents().catch((error) => console.error("Treasury event indexing failed:", error));
}, Number(process.env.INDEX_INTERVAL_MS ?? 5000));
const reconcileTimer = setInterval(
  () => void reconcileTargets(),
  Number(process.env.RECONCILE_INTERVAL_MS ?? 60000)
);
const retentionTimer = policy.enabled
  ? setInterval(() => {
      try {
        runRetention();
      } catch (error) {
        console.error("Retention run failed:", error);
      }
    }, policy.intervalMs)
  : null;

function shutdown() {
  clearInterval(indexTimer);
  clearInterval(reconcileTimer);
  if (retentionTimer) clearInterval(retentionTimer);
  api.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
