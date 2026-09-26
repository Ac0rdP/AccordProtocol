#!/usr/bin/env node

/**
 * indexer.js — Standalone Accord Protocol contract event indexer.
 *
 * Polls Soroban RPC for events emitted by the Accord multisig contract,
 * decodes contract events, persists them to a JSON analytics store,
 * and maintains checkpoint state for resume across restarts.
 *
 * Supports both one-shot mode (--once) and long-running mode (default or --follow).
 *
 * Usage:
 *   node scripts/indexer.js [options]
 *
 * Options:
 *   --once               Run a single indexing cycle and exit
 *   --follow             Run in continuous polling mode (default)
 *   --contract=<id>      Target Accord contract ID (or CONTRACT_ID env)
 *   --rpc=<url>          Soroban RPC URL (or SOROBAN_RPC_URL env)
 *   --store=<path>       Store path (or STORE_PATH env, default: ./data/indexer-store.json)
 *   --interval=<ms>      Polling interval in ms (or POLL_INTERVAL_MS env, default: 5000)
 *   --start-ledger=<n>   Starting ledger if no checkpoint exists (or START_LEDGER env)
 *   --help, -h           Show this help message
 */

import fs from "node:fs";
import path from "node:path";

// Optional dotenv support
try {
  const { default: dotenv } = await import("dotenv");
  dotenv.config();
} catch {
  // dotenv not present
}

// Resilient SDK loading (works both with hoisted node_modules and frontend/node_modules)
let rpc, scValToNative;
try {
  const sdk = await import("@stellar/stellar-sdk");
  rpc = sdk.rpc;
  scValToNative = sdk.scValToNative;
} catch {
  try {
    const sdk = await import("../frontend/node_modules/@stellar/stellar-sdk/lib/index.js");
    rpc = sdk.rpc;
    scValToNative = sdk.scValToNative;
  } catch (err) {
    console.error("Error: Failed to import @stellar/stellar-sdk. Please run `npm --prefix frontend install`.");
    process.exit(1);
  }
}

// ─── CLI Options ─────────────────────────────────────────────────────────────
const rawArgs = process.argv.slice(2);

function printHelp() {
  console.log(`
Accord Event Indexer

Usage:
  node scripts/indexer.js [options]

Options:
  --once               Run one indexing cycle and exit
  --follow             Run in continuous watch/poll mode (default)
  --contract=<id>      Target contract address (required)
  --rpc=<url>          Soroban RPC endpoint (default: https://soroban-testnet.stellar.org)
  --store=<path>       JSON store filepath (default: ./data/indexer-store.json)
  --interval=<ms>      Interval between polls in ms (default: 5000)
  --start-ledger=<n>   Sequence number to start from if no checkpoint exists
  --help, -h           Show this help message

Environment variables:
  CONTRACT_ID / VITE_CONTRACT_ADDRESS       Target contract ID
  SOROBAN_RPC_URL / VITE_SOROBAN_RPC_URL    RPC endpoint
  STORE_PATH / INDEXER_STORE_PATH           Store filepath
  POLL_INTERVAL_MS                          Poll interval in ms
  START_LEDGER                              Initial sequence number
`);
}

if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
  printHelp();
  process.exit(0);
}

const ONCE = rawArgs.includes("--once");
const argContract = rawArgs.find((a) => a.startsWith("--contract="))?.split("=")[1];
const argRpc = rawArgs.find((a) => a.startsWith("--rpc="))?.split("=")[1];
const argStore = (
  rawArgs.find((a) => a.startsWith("--store=")) ||
  rawArgs.find((a) => a.startsWith("--file="))
)?.split("=")[1];
const argInterval = rawArgs.find((a) => a.startsWith("--interval="))?.split("=")[1];
const argStartLedger = rawArgs.find((a) => a.startsWith("--start-ledger="))?.split("=")[1];

const CONTRACT_ID =
  argContract ||
  process.env.CONTRACT_ID ||
  process.env.VITE_CONTRACT_ADDRESS ||
  process.env.ACCORD_CONTRACT_ID ||
  "";

const RPC_URL =
  argRpc ||
  process.env.SOROBAN_RPC_URL ||
  process.env.VITE_SOROBAN_RPC_URL ||
  "https://soroban-testnet.stellar.org";

const STORE_PATH =
  argStore ||
  process.env.STORE_PATH ||
  process.env.INDEXER_STORE_PATH ||
  "./data/indexer-store.json";

const POLL_INTERVAL_MS = Number(
  argInterval ||
  process.env.POLL_INTERVAL_MS ||
  process.env.INDEXER_POLL_INTERVAL_MS ||
  5000
);

const START_LEDGER_CONFIG =
  argStartLedger ||
  process.env.START_LEDGER ||
  null;

// ─── Configuration Validation ────────────────────────────────────────────────
if (!CONTRACT_ID) {
  console.error(
    "Error: Missing CONTRACT_ID. Please set CONTRACT_ID environment variable or pass --contract=<id>."
  );
  process.exit(1);
}

try {
  new URL(RPC_URL);
} catch {
  console.error(`Error: Invalid RPC URL: "${RPC_URL}"`);
  process.exit(1);
}

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function warn(msg) {
  const ts = new Date().toISOString();
  console.warn(`[${ts}] WARN ${msg}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Store & Checkpoint Management ───────────────────────────────────────────
const resolvedStorePath = path.resolve(process.cwd(), STORE_PATH);

function loadStore() {
  if (!fs.existsSync(resolvedStorePath)) {
    return {
      checkpoint: {
        lastLedger: 0,
        updatedAt: null,
      },
      events: [],
      proposals: [],
    };
  }

  try {
    const raw = fs.readFileSync(resolvedStorePath, "utf8").trim();
    if (!raw) {
      return {
        checkpoint: { lastLedger: 0, updatedAt: null },
        events: [],
        proposals: [],
      };
    }

    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return {
        checkpoint: { lastLedger: 0, updatedAt: null },
        events: [],
        proposals: parsed,
      };
    }

    return {
      checkpoint: parsed.checkpoint || { lastLedger: 0, updatedAt: null },
      events: Array.isArray(parsed.events) ? parsed.events : [],
      proposals: Array.isArray(parsed.proposals) ? parsed.proposals : [],
    };
  } catch (err) {
    console.error(`Error: Failed to read or parse store at ${resolvedStorePath}: ${err.message}`);
    process.exit(1);
  }
}

function saveStore(store) {
  try {
    const dir = path.dirname(resolvedStorePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const serialized = JSON.stringify(store, null, 2);
    const tmpPath = `${resolvedStorePath}.tmp`;
    fs.writeFileSync(tmpPath, serialized, "utf8");
    fs.renameSync(tmpPath, resolvedStorePath);
  } catch (err) {
    console.error(`Error: Failed to persist store to ${resolvedStorePath}: ${err.message}`);
    process.exit(1);
  }
}

// ─── Event Decoding & Transformation ─────────────────────────────────────────
function parseVal(scVal) {
  if (!scVal) return null;
  try {
    return scValToNative(scVal);
  } catch {
    return null;
  }
}

function decodeEvent(rawEvent, index) {
  const topics = Array.isArray(rawEvent.topic)
    ? rawEvent.topic.map(parseVal)
    : [parseVal(rawEvent.topic)];
  const value = parseVal(rawEvent.value);

  const topicName = String(topics[0] ?? "").toLowerCase();
  const ledger = rawEvent.ledger;
  const id = rawEvent.id || `${ledger}:${rawEvent.txHash || ""}:${index}`;

  return {
    id,
    topic: topicName,
    topics,
    value,
    ledger,
    txHash: rawEvent.txHash,
    ledgerClosedAt: rawEvent.ledgerClosedAt,
  };
}

function applyEventToProposals(event, proposalsMap) {
  const { topic, value, ledgerClosedAt } = event;
  const timestamp = ledgerClosedAt || new Date().toISOString();

  if (!value || typeof value !== "object") return;

  const propId =
    value.proposal_id ?? value.proposalId ?? value.id ?? value.schedule_id;
  if (propId === undefined || propId === null) return;
  const numId = Number(propId);

  const existing = proposalsMap.get(numId) || {
    id: numId,
    proposer: "Unknown",
    category: "Other",
    amount: "0",
    token: "XLM",
    status: "pending",
    createdAt: timestamp,
    executedAt: null,
  };

  if (topic === "created" || topic === "proposal_created") {
    existing.proposer = String(value.proposer || existing.proposer);
    existing.category = String(value.category || existing.category);
    existing.status = "pending";
    existing.createdAt = timestamp;

    if (Array.isArray(value.transfers) && value.transfers.length > 0) {
      const firstTransfer = value.transfers[0];
      existing.token = String(firstTransfer.token || existing.token);
      existing.amount = String(firstTransfer.amount || existing.amount);
    }
  } else if (topic === "executed" || topic === "proposal_executed") {
    existing.status = "executed";
    existing.executedAt = timestamp;
    if (Array.isArray(value.transfers) && value.transfers.length > 0) {
      const firstTransfer = value.transfers[0];
      existing.token = String(firstTransfer.token || existing.token);
      existing.amount = String(firstTransfer.amount || existing.amount);
    }
  } else if (topic === "rpay" || topic === "recurring_payment_disbursed") {
    existing.status = "executed";
    existing.executedAt = timestamp;
    if (value.amount) existing.amount = String(value.amount);
    if (value.token) existing.token = String(value.token);
  }

  proposalsMap.set(numId, existing);
}

// ─── Main Indexing Cycle ─────────────────────────────────────────────────────
async function main() {
  const server = new rpc.Server(RPC_URL);

  log(`[INFO] Accord Indexer starting...`);
  log(`[INFO] RPC endpoint: ${RPC_URL}`);
  log(`[INFO] Contract ID: ${CONTRACT_ID}`);
  log(`[INFO] Store path: ${resolvedStorePath}`);
  log(`[INFO] Mode: ${ONCE ? "one-shot (--once)" : `continuous (interval: ${POLL_INTERVAL_MS}ms)`}`);

  let store = loadStore();

  let startLedger;
  if (store.checkpoint && store.checkpoint.lastLedger > 0) {
    startLedger = store.checkpoint.lastLedger + 1;
    log(`[INFO] Resuming from checkpoint ledger: ${store.checkpoint.lastLedger}`);
  } else if (START_LEDGER_CONFIG) {
    startLedger = parseInt(START_LEDGER_CONFIG, 10);
    log(`[INFO] Starting from configured START_LEDGER: ${startLedger}`);
  } else {
    try {
      const latest = await server.getLatestLedger();
      startLedger = Math.max(1, latest.sequence - 100);
      log(`[INFO] No checkpoint found. Starting from ledger: ${startLedger}`);
    } catch (err) {
      log(`[WARN] Failed to fetch latest ledger on startup: ${err.message}. Starting from ledger 1.`);
      startLedger = 1;
    }
  }

  // Graceful shutdown handling
  let running = true;
  const onSignal = () => {
    if (!running) process.exit(1);
    running = false;
    log(`[INFO] Received shutdown signal — completing current cycle...`);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  let currentLedger = startLedger;

  while (running) {
    let chainHead = null;
    try {
      const latest = await server.getLatestLedger();
      chainHead = latest.sequence;
    } catch (err) {
      warn(`Failed to query latest ledger: ${err.message}`);
    }

    if (chainHead !== null && currentLedger > chainHead) {
      if (ONCE) {
        log(`[INFO] Already caught up with chain head (${chainHead}). Exiting (--once).`);
        break;
      }
      log(`[INFO] Caught up to chain head (${chainHead}). Waiting ${Math.round(POLL_INTERVAL_MS / 1000)}s before next poll...`);
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    try {
      const res = await server.getEvents({
        startLedger: currentLedger,
        filters: [
          {
            type: "contract",
            contractIds: [CONTRACT_ID],
          },
        ],
        limit: 100,
      });

      const rawEvents = res.events || [];
      const latestSeen = res.latestLedger || currentLedger;

      log(`[INFO] Ingesting ledger range ${currentLedger}..${latestSeen} (found ${rawEvents.length} events)`);

      if (rawEvents.length > 0) {
        // Map existing proposals
        const proposalsMap = new Map();
        for (const p of store.proposals) {
          proposalsMap.set(p.id, p);
        }

        const existingEventIds = new Set(store.events.map((e) => e.id));

        for (let i = 0; i < rawEvents.length; i++) {
          const decoded = decodeEvent(rawEvents[i], i);
          if (!existingEventIds.has(decoded.id)) {
            existingEventIds.add(decoded.id);
            store.events.push(decoded);
          }
          applyEventToProposals(decoded, proposalsMap);
        }

        store.proposals = [...proposalsMap.values()];
      }

      // Checkpoint advances only after persisting batch
      const newCheckpoint = Math.max(currentLedger, latestSeen);
      store.checkpoint = {
        lastLedger: newCheckpoint,
        updatedAt: new Date().toISOString(),
      };

      saveStore(store);
      log(`[INFO] Checkpoint updated to ledger: ${newCheckpoint}`);

      currentLedger = newCheckpoint + 1;

      if (ONCE) {
        log(`[INFO] Completed one-shot ingestion cycle. Exiting.`);
        break;
      }

      if (chainHead !== null && currentLedger > chainHead) {
        log(`[INFO] Caught up to chain head (${chainHead}). Waiting ${Math.round(POLL_INTERVAL_MS / 1000)}s before next poll...`);
        await sleep(POLL_INTERVAL_MS);
      }
    } catch (err) {
      warn(`Transient error polling RPC: ${err.message}. Retrying in ${Math.round(POLL_INTERVAL_MS / 1000)}s...`);
      if (ONCE) {
        console.error(`Error: Ingestion failed in --once mode: ${err.message}`);
        process.exit(1);
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  log(`[INFO] Indexer stopped cleanly.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
