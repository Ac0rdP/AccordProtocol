#!/usr/bin/env node
/**
 * Generate a deterministic, secret-free seed dataset for frontend PR previews.
 *
 * Pull-request preview builds have no indexer or analytics API behind them. This
 * script turns the committed sample dataset (`scripts/sample-analytics-data.json`)
 * into an `AnalyticsContext` — the exact shape the analytics route handlers in
 * `frontend/src/lib/analyticsApi.ts` consume — and writes it to
 * `frontend/public/preview-seed.json`, which the preview build serves as static
 * JSON and `frontend/src/lib/previewSeed.ts` loads at runtime.
 *
 * Safety: previews run with GITHUB_TOKEN and no application secrets, and the
 * build only ever reads the committed sample data. As a belt-and-braces check
 * the script refuses to write output that contains the value of any
 * secret-looking environment variable.
 *
 * Usage:
 *   node scripts/seed-preview.mjs [--out <path>]
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = resolve(root, "scripts/sample-analytics-data.json");

/** Owners surfaced in spend-by-owner, including ones with zero spend. */
const SEED_OWNERS = [
  "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4IQDNC",
  "GBZXBCBP4A3RUGQ6E7Z46N3N3J67HCH34T3Z7Q6DCLOXX367G4B34CBO",
  "GCCZUKX7LI3MSLUA4MIIN3LSO43DTBPJMHBPSTUQISDLMZMPOJU3ANWJ",
];

const SEED_DEPOSITS = [
  { timestamp: "2026-09-01T00:00:00Z", token: "USDC", amount: "12000.00" },
  { timestamp: "2026-09-01T00:00:00Z", token: "XLM", amount: "8000.00" },
  { timestamp: "2026-09-15T00:00:00Z", token: "USDC", amount: "6000.00" },
];

const RECIPIENT = "GRECIPIENTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function unixSeconds(iso) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`Invalid ISO date in sample data: ${iso}`);
  return Math.floor(ms / 1000);
}

function parseArgs(argv) {
  const outIndex = argv.indexOf("--out");
  const out =
    outIndex !== -1 && argv[outIndex + 1]
      ? resolve(argv[outIndex + 1])
      : resolve(root, "frontend/public/preview-seed.json");
  return { out };
}

function buildProposals(raw) {
  return raw.map((entry, index) => {
    const executedAt = entry.executedAt ?? "2026-09-01T00:00:00Z";
    const deadline = executedAt.slice(0, 10);
    return {
      id: Number(entry.id ?? index + 1),
      kind: "transfer",
      to: RECIPIENT,
      amount: String(entry.amount ?? "0"),
      token: String(entry.token ?? "XLM"),
      description: `${entry.category ?? "Transfer"} payout`,
      approvals: 2,
      threshold: 2,
      status: entry.status ?? "executed",
      deadline,
      deadlineTs: unixSeconds(executedAt),
      createdAt: executedAt,
      proposer: String(entry.proposer ?? SEED_OWNERS[0]),
      userHasApproved: false,
      approverAddresses: SEED_OWNERS.slice(1),
      executedAt,
      category: entry.category ?? "Other",
    };
  });
}

function buildBalanceSnapshots(deposits) {
  const running = {};
  return deposits
    .slice()
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((deposit) => {
      running[deposit.token] =
        (running[deposit.token] ?? 0) + (parseFloat(deposit.amount) || 0);
      return {
        timestamp: unixSeconds(deposit.timestamp),
        balances: { ...running },
      };
    });
}

function buildContext(raw) {
  const proposals = buildProposals(raw);
  const owners = [...new Set([...proposals.map((p) => p.proposer), ...SEED_OWNERS])];
  const deposits = SEED_DEPOSITS.map((d) => ({
    timestamp: unixSeconds(d.timestamp),
    token: d.token,
    amount: d.amount,
  }));
  return {
    proposals,
    ownerCount: owners.length,
    owners,
    deposits,
    balanceSnapshots: buildBalanceSnapshots(SEED_DEPOSITS),
  };
}

/**
 * Refuse to emit any value of a secret-looking environment variable so a
 * misconfigured CI job can never bake a credential into a public preview.
 */
function assertNoSecrets(serialized) {
  const suspicious = /(SECRET|TOKEN|PASSWORD|PRIVATE_KEY|MNEMONIC|CREDENTIAL)/i;
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || value.length < 8 || !suspicious.test(key)) continue;
    if (serialized.includes(value)) {
      throw new Error(
        `Refusing to write preview seed: it contains the value of ${key}.`,
      );
    }
  }
}

function main() {
  const { out } = parseArgs(process.argv.slice(2));
  const raw = JSON.parse(readFileSync(SOURCE, "utf8"));
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`Sample dataset ${SOURCE} is empty or not an array.`);
  }

  const context = buildContext(raw);
  const serialized = `${JSON.stringify(context, null, 2)}\n`;
  assertNoSecrets(serialized);

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, serialized, "utf8");

  console.log(
    `Preview seed written to ${out}: ` +
      `${context.proposals.length} proposals, ${context.deposits.length} deposits, ` +
      `${context.ownerCount} owners.`,
  );
}

main();
