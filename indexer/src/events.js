import { scValToNative, xdr } from "@stellar/stellar-sdk";
import { getEventSchema } from "./catalog.js";

function decodeScVal(encoded) {
  const value = typeof encoded === "string" ? xdr.ScVal.fromXDR(encoded, "base64") : encoded;
  return scValToNative(value);
}

function addressString(value) {
  return String(value);
}

/**
 * The stable identity of a contract event: `ledger:transaction:eventIndex`.
 *
 * It is derived from where the event sits on chain, so re-fetching it from the
 * RPC (a retry, a backfill overlap, a reindex) always yields the same key. The
 * event index is the RPC's own `eventIndex`/`index` when present, otherwise the
 * numeric suffix of the Soroban event id (`<toid>-<eventIndex>`); an id with no
 * usable suffix is used verbatim so two events can never share a key.
 */
export function eventDedupeKey(event) {
  const ledger = Number(event.ledger);
  const transaction = event.txHash ?? "unknown";
  const id = String(event.id ?? event.pagingToken ?? "");
  const suffix = id.includes("-") ? id.slice(id.lastIndexOf("-") + 1) : "";
  const explicit = event.eventIndex ?? event.index;
  const index = explicit !== undefined && explicit !== null
    ? String(explicit)
    : /^\d+$/.test(suffix) ? String(Number(suffix)) : id;
  return `${ledger}:${transaction}:${index}`;
}

export function parseTokenTransferEvent(event, tokenNames, treasuryAddress, target) {
  const tokenAddress = String(event.contractId ?? "");
  const token = tokenNames.get(tokenAddress.toLowerCase());
  if (!token || !Array.isArray(event.topic) || event.topic.length < 3) return null;

  const [eventName, fromValue, toValue] = event.topic.map(decodeScVal);
  if (eventName !== "transfer") return null;

  const from = addressString(fromValue);
  const to = addressString(toValue);
  const treasury = treasuryAddress.toLowerCase();
  const isInflow = to.toLowerCase() === treasury;
  const isOutflow = from.toLowerCase() === treasury;
  if (!isInflow && !isOutflow) return null;

  const amount = BigInt(decodeScVal(event.value));
  if (amount <= 0n) return null;

  const ledger = Number(event.ledger);
  const transactionHash = event.txHash ?? null;
  return {
    network: target?.network ?? null,
    contractId: target?.contractId ?? treasuryAddress,
    eventId: String(event.id ?? event.pagingToken ?? `${ledger}:${transactionHash ?? "unknown"}`),
    dedupeKey: eventDedupeKey(event),
    token,
    tokenAddress,
    direction: isInflow ? "inflow" : "outflow",
    amount: amount.toString(),
    ledger,
    transactionHash,
    occurredAt: new Date(event.ledgerClosedAt).toISOString(),
    from,
    to,
  };
}

export function parseAccordEvent(event, treasuryAddress, target) {
  const contractId = String(event.contractId ?? "").toLowerCase();
  if (contractId !== treasuryAddress.toLowerCase()) return null;
  if (!Array.isArray(event.topic) || event.topic.length === 0) return null;

  const topicName = decodeScVal(event.topic[0]);
  const schema = getEventSchema(topicName);
  if (!schema) return null; // Not an Accord protocol event from the catalog

  const payload = decodeScVal(event.value);
  const ledger = Number(event.ledger);
  const transactionHash = event.txHash ?? null;

  // scValToNative output can contain BigInts or complex objects.
  // We can convert BigInts to strings for JSON serialization if necessary,
  // but JSON.stringify in ledger.js will throw on BigInts natively.
  // Let's recursively replace BigInt with string in the payload.
  const sanitize = (val) => {
    if (typeof val === "bigint") return val.toString();
    if (Array.isArray(val)) return val.map(sanitize);
    if (val !== null && typeof val === "object") {
      const obj = {};
      for (const [k, v] of Object.entries(val)) {
        obj[k] = sanitize(v);
      }
      return obj;
    }
    return val;
  };

  // Every contract event carries a `version` field (the event-schema version,
  // `EVENT_SCHEMA_VERSION` in the contract). Events from pre-versioning
  // deployments have none and are recorded with a null schema version.
  const rawVersion = payload !== null && typeof payload === "object" ? payload.version : undefined;
  const schemaVersion = rawVersion === undefined || rawVersion === null ? null : Number(rawVersion);

  return {
    network: target?.network ?? null,
    contractId: target?.contractId ?? treasuryAddress,
    eventId: String(event.id ?? event.pagingToken ?? `${ledger}:${transactionHash ?? "unknown"}`),
    dedupeKey: eventDedupeKey(event),
    topic: topicName,
    schemaVersion,
    payload: sanitize(payload),
    ledger,
    transactionHash,
    occurredAt: new Date(event.ledgerClosedAt).toISOString(),
  };
}