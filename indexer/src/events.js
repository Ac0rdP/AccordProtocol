import { scValToNative, xdr } from "@stellar/stellar-sdk";

function decodeScVal(encoded) {
  const value = typeof encoded === "string" ? xdr.ScVal.fromXDR(encoded, "base64") : encoded;
  return scValToNative(value);
}

function addressString(value) {
  return String(value);
}

export function parseTokenTransferEvent(event, tokenNames, treasuryAddress) {
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
    eventId: String(event.id ?? event.pagingToken ?? `${ledger}:${transactionHash ?? "unknown"}`),
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