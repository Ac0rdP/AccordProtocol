/** 1 XLM = 10,000,000 stroops — the Stellar token precision used by Soroban. */
export const STROOPS_PER_UNIT = 10_000_000n;

export function safeBigInt(value: unknown): bigint {
  try {
    if (
      typeof value === "bigint" ||
      typeof value === "number" ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      return BigInt(value);
    }
  } catch {
    // fall through
  }
  return 0n;
}

/** Mirrors `frontend/src/lib/soroban.ts::stroopsToDisplay`. */
export function stroopsToDisplay(value: bigint): string {
  const whole = value / STROOPS_PER_UNIT;
  const frac = value % STROOPS_PER_UNIT;
  if (frac === 0n) return whole.toString();
  return `${whole.toString()}.${frac
    .toString()
    .padStart(7, "0")
    .replace(/0+$/, "")}`;
}

export function shortenAddress(address: string): string {
  if (!address || address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/** Deterministic UTC label so snapshots do not depend on device locale. */
export function formatDeadline(timestampSeconds: number): string {
  if (!Number.isFinite(timestampSeconds) || timestampSeconds <= 0) return "No deadline";
  return new Date(timestampSeconds * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}
