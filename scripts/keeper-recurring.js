#!/usr/bin/env node
/**
 * Accord Protocol — Example off-chain keeper for recurring disbursements.
 *
 * Polls due recurring payment schedules and calls `disburse_recurring` for each.
 *
 * Contract entrypoint `disburse_recurring(schedule_id: u64)` is permissionless
 * (any funded address may call it) — see contracts/accord/src/lib.rs:2661.
 *
 * NOTE on `get_due_recurring_payments`: the current contract does not expose a
 * bulk "due" view. This keeper emulates it client-side by scanning schedule IDs
 * and checking `get_claimable_amount(schedule_id) > 0` (lib.rs:2777), which
 * returns 0 for non-Active / cliff-locked / interval-not-elapsed / cap-exhausted
 * schedules. If a future `get_due_recurring_payments() -> Vec<u64>` view is added,
 * replace `getDueScheduleIds()` with a single `simulateView("get_due_recurring_payments")` call.
 *
 * Pattern follows frontend/src/lib/submit.ts (TransactionBuilder → simulate →
 * assemble → sign → send → poll) and frontend/src/lib/contract.ts:29 (simulateView).
 *
 * Usage:
 *   npm install @stellar/stellar-sdk dotenv   # once
 *   cp .env.example .env                      # then fill CONTRACT_ID + KEEPER_SECRET_KEY
 *   node scripts/keeper-recurring.js
 *   node scripts/keeper-recurring.js --once --dry-run
 *   KEEPER_POLL_INTERVAL_MS=60000 node scripts/keeper-recurring.js
 */

import { Contract, Keypair, nativeToScVal, rpc, scValToNative, TransactionBuilder } from "@stellar/stellar-sdk";

// Optional dotenv — silently ignore if not installed or no .env file.
try {
  const { default: dotenv } = await import("dotenv");
  dotenv.config();
} catch {
  // dotenv not available — env must be set externally
}

// ─── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const ONCE = args.includes("--once");
const DRY_RUN = args.includes("--dry-run");
const HELP = args.includes("--help") || args.includes("-h");
const intervalArg = args.find((a) => a.startsWith("--interval="));
const maxScanArg = args.find((a) => a.startsWith("--max-scan="));

if (HELP) {
  console.log(`
Accord keeper — recurring disbursements

Usage:
  node scripts/keeper-recurring.js [options]

Options:
  --once              Run a single poll cycle and exit (useful for cron)
  --dry-run           Detect due schedules but do not submit disburse txs
  --interval=MS       Poll interval in ms (overrides KEEPER_POLL_INTERVAL_MS)
  --max-scan=N        Max schedule ID to scan (overrides KEEPER_MAX_SCAN_IDS)
  --help, -h          Show this help

Env:
  SOROBAN_RPC_URL / VITE_SOROBAN_RPC_URL   (default https://soroban-testnet.stellar.org)
  CONTRACT_ID / VITE_CONTRACT_ADDRESS      (required)
  NETWORK_PASSPHRASE / VITE_NETWORK_PASSPHRASE (default Test SDF Network ; September 2015)
  KEEPER_SECRET_KEY                        (required unless --dry-run)
  KEEPER_POLL_INTERVAL_MS                  (default 30000)
  KEEPER_MAX_SCAN_IDS                      (default 100)
`);
  process.exit(0);
}

// ─── Config ─────────────────────────────────────────────────────────────────
const RPC_URL =
  process.env.SOROBAN_RPC_URL ||
  process.env.VITE_SOROBAN_RPC_URL ||
  "https://soroban-testnet.stellar.org";

const CONTRACT_ID =
  process.env.CONTRACT_ID ||
  process.env.VITE_CONTRACT_ADDRESS ||
  process.env.ACCORD_CONTRACT_ID ||
  "";

const NETWORK_PASSPHRASE =
  process.env.NETWORK_PASSPHRASE ||
  process.env.VITE_NETWORK_PASSPHRASE ||
  "Test SDF Network ; September 2015";

const KEEPER_SECRET_KEY = process.env.KEEPER_SECRET_KEY || process.env.SECRET_KEY || "";

// Poll interval: CLI > env > default 30s
const POLL_INTERVAL_MS = intervalArg
  ? Number(intervalArg.split("=")[1])
  : Number(process.env.KEEPER_POLL_INTERVAL_MS || process.env.POLL_INTERVAL_MS || 30_000);

// Upper bound for ID scan — MAX_ACTIVE_RECURRING is 20 (lib.rs:594), but completed/
// cancelled IDs remain stored, so we scan a bit further. Cheap: each ID is one
// simulateTransaction round-trip (~200ms).
const MAX_SCAN_IDS = maxScanArg
  ? Number(maxScanArg.split("=")[1])
  : Number(process.env.KEEPER_MAX_SCAN_IDS || 100);

function log(msg, ...rest) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`, ...rest);
}

function warn(msg, ...rest) {
  const ts = new Date().toISOString();
  console.warn(`[${ts}] WARN ${msg}`, ...rest);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isMissingContractError(errMsg) {
  return /RecurringPaymentNotFound|#39/i.test(errMsg);
}

// ─── Validation ─────────────────────────────────────────────────────────────
if (!CONTRACT_ID) {
  console.error(
    "Missing CONTRACT_ID. Set CONTRACT_ID or VITE_CONTRACT_ADDRESS env var.\n" +
      "Example: CONTRACT_ID=C... node scripts/keeper-recurring.js --dry-run"
  );
  process.exit(1);
}

if (!KEEPER_SECRET_KEY && !DRY_RUN) {
  console.error(
    "Missing KEEPER_SECRET_KEY. Set KEEPER_SECRET_KEY env var to a funded Stellar secret (S...).\n" +
      "For a read-only check, run with --dry-run instead."
  );
  process.exit(1);
}

let keeperKeypair = null;
let keeperPublicKey = null;
if (KEEPER_SECRET_KEY) {
  try {
    keeperKeypair = Keypair.fromSecret(KEEPER_SECRET_KEY);
    keeperPublicKey = keeperKeypair.publicKey();
  } catch (e) {
    console.error(`Invalid KEEPER_SECRET_KEY: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
} else {
  // dry-run without key — use a placeholder funded address for simulation only
  keeperPublicKey =
    process.env.VITE_SIM_SOURCE ||
    process.env.SIM_SOURCE ||
    "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
  warn(`No KEEPER_SECRET_KEY — dry-run mode, simulating as ${keeperPublicKey.slice(0, 8)}...`);
}

// ─── Stellar client ─────────────────────────────────────────────────────────
const server = new rpc.Server(RPC_URL);
const contract = new Contract(CONTRACT_ID);

// ─── Read helpers (mirror frontend/src/lib/contract.ts:29 simulateView) ──────
async function simulateView(fn, args = []) {
  const account = await server.getAccount(keeperPublicKey);
  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(fn, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim)) {
    const err = sim;
    throw new Error(`${fn}: ${err.error ?? "simulation failed"}`);
  }
  return sim.result.retval;
}

async function getClaimableAmount(scheduleId) {
  const retval = await simulateView("get_claimable_amount", [
    nativeToScVal(BigInt(scheduleId), { type: "u64" }),
  ]);
  const raw = scValToNative(retval);
  // scValToNative may return bigint, number, or string for i128
  try {
    return BigInt(raw);
  } catch {
    return BigInt(Number(raw) || 0);
  }
}

async function getActiveRecurringCount() {
  try {
    const retval = await simulateView("get_active_recurring_count");
    const raw = scValToNative(retval);
    return Number(raw) || 0;
  } catch {
    return null;
  }
}

// Optional richer context for logging (best-effort)
async function getRecurringPayment(scheduleId) {
  try {
    const retval = await simulateView("get_recurring_payment", [
      nativeToScVal(BigInt(scheduleId), { type: "u64" }),
    ]);
    return scValToNative(retval);
  } catch {
    return null;
  }
}

// ─── Due detection (emulates get_due_recurring_payments) ────────────────────
// Scans IDs 1..MAX_SCAN_IDS sequentially. Uses get_claimable_amount > 0 as the
// "due" predicate — matches lib.rs:2777 logic (Active + past start/cliff +
// interval elapsed + remaining cap > 0).
async function getDueScheduleIds() {
  const dueIds = [];
  let consecutiveMisses = 0;
  const activeCount = await getActiveRecurringCount();
  if (activeCount !== null) {
    log(`Active recurring count: ${activeCount}`);
  }

  for (let id = 1; id <= MAX_SCAN_IDS; id++) {
    try {
      const claimable = await getClaimableAmount(id);
      consecutiveMisses = 0; // found an ID, reset
      if (claimable > 0n) {
        dueIds.push({ id, claimable });
        // Fetch context for nicer logging (non-critical)
        const sched = await getRecurringPayment(id);
        if (sched) {
          log(`  → schedule #${id} due: claimable=${claimable} recipient=${sched.recipient ?? "?"} token=${sched.token ?? "?"}`);
        } else {
          log(`  → schedule #${id} due: claimable=${claimable}`);
        }
      }
      // Small pacing to avoid RPC rate limits
      await sleep(80);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isMissingContractError(msg)) {
        consecutiveMisses++;
        // IDs are monotonically increasing (recur_next_id_key: "RNEXT" lib.rs:601),
        // never reused. Once we see a gap, schedules beyond may still exist only
        // if there are interleaved holes — which never happen. So after a few
        // consecutive misses past the high-water mark we can stop early.
        // Keep scanning a bit longer when activeCount is unknown.
        const threshold = activeCount !== null && activeCount === 0 ? 3 : 10;
        if (consecutiveMisses >= threshold) {
          // Peek ahead one more window to be safe if MAX_SCAN is small
          if (id >= 20) break;
        }
        await sleep(40);
        continue;
      }
      // Other simulation errors (e.g. NotInitialized) — log and continue
      warn(`get_claimable_amount(${id}) failed: ${msg}`);
      consecutiveMisses = 0;
      await sleep(80);
    }
  }

  return dueIds;
}

// ─── Write: disburse_recurring (mirror frontend/src/lib/submit.ts:16 buildAndSubmit) ──
async function disburseRecurring(scheduleId) {
  if (!keeperKeypair) throw new Error("No keeper keypair — cannot sign");

  const account = await server.getAccount(keeperPublicKey);

  const tx = new TransactionBuilder(account, {
    fee: "100000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call("disburse_recurring", nativeToScVal(BigInt(scheduleId), { type: "u64" })))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim)) {
    const err = sim;
    throw new Error(`Simulation failed for disburse_recurring(${scheduleId}): ${err.error ?? "unknown"}`);
  }

  const assembled = rpc.assembleTransaction(tx, sim).build();
  assembled.sign(keeperKeypair);

  const sent = await server.sendTransaction(assembled);
  if (sent.status === "ERROR") {
    throw new Error(`Submit failed disburse_recurring(${scheduleId}): ${JSON.stringify(sent.errorResult)}`);
  }

  const hash = sent.hash;
  log(`Submitted disburse_recurring(${scheduleId}) tx ${hash} — waiting for confirmation...`);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await sleep(2000);
    const res = await server.getTransaction(hash);
    if (res.status === "SUCCESS") {
      log(`✓ disburse_recurring(${scheduleId}) confirmed in ledger ${res.ledger} (tx ${hash})`);
      return hash;
    }
    if (res.status === "FAILED") {
      throw new Error(`Transaction ${hash} for schedule ${scheduleId} failed on-chain`);
    }
  }
  throw new Error(`Transaction ${hash} for schedule ${scheduleId} not confirmed within 30s`);
}

// ─── Single poll cycle ───────────────────────────────────────────────────────
async function runOnce() {
  log(`Polling due schedules (max scan ${MAX_SCAN_IDS}) via get_claimable_amount...`);
  let due;
  try {
    due = await getDueScheduleIds();
  } catch (e) {
    warn(`Failed to fetch due schedules: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  if (due.length === 0) {
    log("No due schedules found.");
    return;
  }

  log(`Found ${due.length} due schedule(s): ${due.map((d) => `#${d.id} (${d.claimable})`).join(", ")}`);

  if (DRY_RUN) {
    log("[dry-run] Skipping disburse submission.");
    return;
  }

  for (const { id } of due) {
    try {
      await disburseRecurring(id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Expected benign failures: too early, not active, ended, frozen — keep keeper alive
      if (/DisbursementTooEarly|#42|ScheduleNotActive|#41|ScheduleEnded|#43|ContractFrozen|#26/i.test(msg)) {
        warn(`Skipping schedule #${id}: ${msg}`);
      } else {
        warn(`Failed disburse_recurring(${id}): ${msg}`);
      }
      // Brief backoff between submits to avoid sequence conflicts
      await sleep(1200);
    }
    // Pacing between disbursements
    await sleep(600);
  }
}

// ─── Main loop ───────────────────────────────────────────────────────────────
async function main() {
  log(`Accord keeper starting`);
  log(`  RPC: ${RPC_URL}`);
  log(`  Contract: ${CONTRACT_ID}`);
  log(`  Network: ${NETWORK_PASSPHRASE}`);
  log(`  Keeper: ${keeperPublicKey}`);
  log(`  Poll interval: ${POLL_INTERVAL_MS}ms  Max scan: ${MAX_SCAN_IDS}  Once: ${ONCE}  Dry-run: ${DRY_RUN}`);

  // Quick sanity check — verify contract is reachable
  try {
    await getActiveRecurringCount();
  } catch (e) {
    warn(`Initial RPC check failed (contract may be uninitialized or RPC unreachable): ${e instanceof Error ? e.message : String(e)}`);
  }

  if (ONCE) {
    await runOnce();
    log("Done (--once). Exiting.");
    process.exit(0);
  }

  // Continuous polling
  let running = true;
  const onSignal = () => {
    if (!running) process.exit(1);
    running = false;
    log("Received shutdown signal — finishing current cycle then exiting...");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  while (running) {
    const cycleStart = Date.now();
    try {
      await runOnce();
    } catch (e) {
      warn(`Poll cycle error: ${e instanceof Error ? e.message : String(e)}`);
    }
    const elapsed = Date.now() - cycleStart;
    const waitMs = Math.max(0, POLL_INTERVAL_MS - elapsed);
    if (running && waitMs > 0) {
      log(`Next poll in ${Math.round(waitMs / 1000)}s — Ctrl+C to stop`);
      await sleep(waitMs);
    }
  }

  log("Keeper stopped.");
}

main().catch((e) => {
  console.error(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  if (e instanceof Error && e.stack) console.error(e.stack);
  process.exit(1);
});
