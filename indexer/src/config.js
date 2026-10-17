import { readFileSync } from "node:fs";

const KNOWN_PASSPHRASES = new Map([
  ["Public Global Stellar Network ; September 2015", "pubnet"],
  ["Test SDF Network ; September 2015", "testnet"],
  ["Test SDF Future Network ; October 2022", "futurenet"],
  ["Standalone Network ; February 2017", "standalone"],
]);

const DEFAULT_RPC_URL = "https://soroban-testnet.stellar.org";
const DEFAULT_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

export function networkFromPassphrase(passphrase) {
  return KNOWN_PASSPHRASES.get(passphrase) ?? "custom";
}

export function targetKey({ network, contractId }) {
  return `${network}/${contractId}`;
}

function trimmed(value) {
  return typeof value === "string" ? value.trim() : value;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseTokens(raw, label) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${label} must list at least one token`);
  }
  return raw.map((token, position) => {
    const name = trimmed(token?.name);
    const address = trimmed(token?.address);
    if (!name || !address) {
      throw new Error(`${label}.tokens[${position}] needs both a name and an address`);
    }
    return { name: name.toUpperCase(), address };
  });
}

function tokensFromEnv(env) {
  const tokens = [];
  if (env.XLM_TOKEN_ADDRESS?.trim()) {
    tokens.push({ name: "XLM", address: env.XLM_TOKEN_ADDRESS.trim() });
  }
  if (env.USDC_TOKEN_ADDRESS?.trim()) {
    tokens.push({ name: "USDC", address: env.USDC_TOKEN_ADDRESS.trim() });
  }
  return tokens;
}

function normaliseTarget(raw, position, defaults) {
  const label = `INDEXER_TARGETS[${position}]`;
  const contractId = trimmed(raw?.contractId) ?? defaults.contractId;
  if (!contractId) throw new Error(`${label}.contractId must be set`);

  const networkPassphrase = trimmed(raw?.networkPassphrase) ?? defaults.networkPassphrase;
  const network = trimmed(raw?.network) ?? networkFromPassphrase(networkPassphrase);
  const rpcUrl = trimmed(raw?.rpcUrl) ?? defaults.rpcUrl;
  const simulationSource = trimmed(raw?.simulationSource) ?? defaults.simulationSource;
  if (!simulationSource) {
    throw new Error(`${label}.simulationSource must be set (directly or via SIM_SOURCE)`);
  }

  const startLedger = positiveInteger(
    raw?.startLedger ?? defaults.startLedger,
    `${label}.startLedger`
  );
  const tokens = parseTokens(
    Array.isArray(raw?.tokens) && raw.tokens.length > 0 ? raw.tokens : defaults.tokens,
    label
  );

  return {
    id: trimmed(raw?.id) || `${network}-${contractId.slice(0, 8).toLowerCase()}`,
    network,
    networkPassphrase,
    rpcUrl,
    contractId,
    simulationSource,
    startLedger,
    tokens,
    key: targetKey({ network, contractId }),
  };
}

function readTargetsSource(env) {
  if (env.INDEXER_TARGETS_FILE?.trim()) {
    return JSON.parse(readFileSync(env.INDEXER_TARGETS_FILE.trim(), "utf8"));
  }
  if (env.INDEXER_TARGETS?.trim()) {
    return JSON.parse(env.INDEXER_TARGETS.trim());
  }
  return null;
}

/**
 * Builds the list of (network, contract) pairs this process indexes.
 *
 * `INDEXER_TARGETS` (inline JSON) or `INDEXER_TARGETS_FILE` describe the full
 * list. Any field a target omits falls back to the single-target environment
 * variables, which on their own still describe one legacy target.
 */
export function loadTargets(env = process.env) {
  const defaults = {
    contractId: trimmed(env.ACCORD_CONTRACT_ID) || undefined,
    networkPassphrase: trimmed(env.NETWORK_PASSPHRASE) || DEFAULT_NETWORK_PASSPHRASE,
    rpcUrl: trimmed(env.SOROBAN_RPC_URL) || DEFAULT_RPC_URL,
    simulationSource: trimmed(env.SIM_SOURCE) || undefined,
    startLedger: env.INDEXER_START_LEDGER,
    tokens: tokensFromEnv(env),
  };

  const source = readTargetsSource(env);
  const rawTargets = source === null ? [{}] : source;
  if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
    throw new Error("INDEXER_TARGETS must be a non-empty JSON array of targets");
  }

  const targets = rawTargets.map((raw, position) => normaliseTarget(raw, position, defaults));

  const seenKeys = new Set();
  const seenIds = new Set();
  for (const target of targets) {
    if (seenKeys.has(target.key)) {
      throw new Error(`Duplicate indexer target for ${target.key}`);
    }
    if (seenIds.has(target.id)) {
      throw new Error(`Duplicate indexer target id "${target.id}"`);
    }
    seenKeys.add(target.key);
    seenIds.add(target.id);
  }

  return targets;
}
