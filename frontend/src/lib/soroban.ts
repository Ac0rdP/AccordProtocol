export function formatDeadline(ts: bigint): string {
  return new Date(Number(ts) * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function shortenAddr(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function stroopsToDisplay(value: bigint): string {
  // Soroban token amounts use 7 decimal places (Stellar standard).
  const whole = value / 10_000_000n;
  const frac = value % 10_000_000n;
  if (frac === 0n) return whole.toString();
  return `${whole.toString()}.${frac.toString().padStart(7, "0").replace(/0+$/, "")}`;
}

export function displayToStroops(value: number): bigint {
  if (isNaN(value)) return 0n;
  // Stellar uses 7 decimal places: 1 XLM = 10_000_000 stroops
  return BigInt(Math.round(value * 10_000_000));
}

export type PermissionAction = "create" | "approve" | "execute";

const ACTION_LABELS: Record<PermissionAction, string> = {
  create: "Creating proposals",
  approve: "Approving proposals",
  execute: "Executing proposals",
};

// The multisig owners are the wallets that fund, approve, and execute
// proposals, so the Owner role grants every action. Fine-grained Proposer /
// Approver / Executor roles let the contract delegate individual actions to
// non-owner wallets without loosening owner access.
export function canCreate(roles: readonly string[]): boolean {
  return roles.includes("Proposer") || roles.includes("Owner");
}

export function canApprove(roles: readonly string[]): boolean {
  return roles.includes("Approver") || roles.includes("Owner");
}

export function canExecute(roles: readonly string[]): boolean {
  return roles.includes("Executor") || roles.includes("Owner");
}

export function missingRoleTooltip(action: PermissionAction): string {
  const roleReq = 
    action === "create" ? "Proposer" :
    action === "approve" ? "Approver" :
    action === "execute" ? "Executor" : "required";
  return `${ACTION_LABELS[action]} requires the ${roleReq} role.`;
}

export const CONTRACT_ERRORS: Record<string, string> = {
  "1": "Contract is already initialized.",
  "2": "Contract has not been initialized.",
  "3": "Unauthorized. Make sure you are using the correct account.",
  "4": "Invalid threshold value.",
  "5": "Invalid list of owners.",
  "6": "Proposal not found. Please refresh and try again.",
  "7": "This proposal is no longer active.",
  "8": "You have already approved this proposal.",
  "9": "You have not approved this proposal.",
  "10": "Approval threshold has not been met.",
  "11": "This proposal has expired.",
  "12": "Invalid amount specified.",
  "13": "Invalid deadline.",
  "14": "Invalid token selected.",
  "15": "Token transfer failed. Check the contract balance.",
  "16": "Proposal description cannot be empty.",
  "17": "Proposal description is too long.",
  "18": "Too many active proposals. Try again later.",
  "19": "Duplicate owner address detected.",
  "20": "Arithmetic error occurred during calculation.",
  "21": "Invalid duration for the proposal.",
  "22": "Invalid recipient address.",
  "23": "Time lock is still active. Please wait.",
  "24": "Removing this owner would break the required threshold.",
  "25": "Owner not found.",
  "26": "Contract is frozen.",
  "27": "No guardian has been configured.",
  "28": "Invalid recurring interval.",
  "29": "Invalid recurring schedule dates.",
  "30": "Recurring cap must be at least the payment amount.",
  "31": "This proposal exceeds the current spending limit.",
  "32": "Recurring payment not found.",
  "33": "Recurring payment is not due yet.",
  "34": "Recurring payment has completed or reached its cap.",
  "35": "Recurring payment is inactive.",
  "36": "Recurring payment interval has not elapsed yet.",
  "37": "Too many active recurring payments. Try again later.",
  "38": "Recurring schedule is already cancelled.",
  "39": "Recurring schedule is already paused.",
  "40": "Recurring schedule is not paused.",
  "41": "Recurring schedule has reached a terminal state and cannot be modified.",
  "42": "Invalid weights list length.",
  "43": "Owner weight is below the minimum required.",
  "44": "Invalid owner weight.",
  "45": "Contract has already been migrated to weighted governance.",
  "46": "Single owner weight exceeds the allowed cap.",
  "47": "Target owner no longer exists.",
  "48": "Action would break the required quorum.",
  "49": "Cannot remove the last remaining owner.",
  "50": "Threshold exceeds the total number of owners.",
  "51": "Recurring schedule is not active.",
  "52": "Action requires a role that this account does not hold.",
  "53": "Role is already granted to this account.",
  "54": "Role is not granted to this account.",
  "55": "Specified role is not valid for this context.",
  "56": "This entrypoint is deprecated and can no longer be called directly.",
  "57": "Account recovery is currently active.",
};

export function contractErrorMessage(error: string): string {
  const fallback = "Something went wrong while processing the transaction. Please try again.";
  if (!error) return fallback;

  // Extract the error code from formats like "Error(Contract,#5)" or "Error(Contract, #5)"
  const match = error.match(/Error\(Contract,\s*#(\d+)\)/i);
  if (match && match[1]) {
    const code = match[1];
    return CONTRACT_ERRORS[code] || fallback;
  }

  return fallback;
}

export function formatInterval(seconds: number | bigint | string): string {
  const s = Number(seconds);
  if (isNaN(s) || s <= 0) return "—";
  if (s === 86400) return "Daily";
  if (s === 604800) return "Weekly";
  if (s === 2592000 || s === 2629743 || s === 2629800) return "Monthly";
  if (s === 31536000) return "Yearly";
  if (s % 86400 === 0) {
    const days = s / 86400;
    return days === 1 ? "1 day" : `Every ${days} days`;
  }
  if (s % 3600 === 0) {
    const hours = s / 3600;
    return hours === 1 ? "1 hour" : `Every ${hours} hours`;
  }
  if (s % 60 === 0) {
    const mins = s / 60;
    return mins === 1 ? "1 min" : `Every ${mins} mins`;
  }
  return `Every ${s}s`;
}

export function formatCountdown(targetMs: number): string {
  const diff = targetMs - Date.now();
  if (diff <= 0) return "Due now";
  const totalSecs = Math.floor(diff / 1000);
  const days = Math.floor(totalSecs / 86400);
  const hours = Math.floor((totalSecs % 86400) / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  if (days > 0) return `next in ${days}d ${hours}h`;
  if (hours > 0) return `next in ${hours}h ${mins}m`;
  if (mins > 0) return `next in ${mins}m`;
  return "next in <1m";
}


/**
 * Format decimal token units without converting strings through Number.
 * bigint inputs are base units; Stellar XLM and USDC both default to 7 decimals.
 * Other tokens can supply their decimals explicitly. Output uses en-US grouping.
 */
export function formatCurrency(
  value: string | number | bigint,
  token: string,
  decimals = 7,
): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 100) return "—";
  let text: string;
  if (typeof value === "bigint") {
    const magnitude = value < 0n ? -value : value;
    const scale = 10n ** BigInt(decimals);
    text = `${value < 0n ? "-" : ""}${magnitude / scale}.${(magnitude % scale).toString().padStart(decimals, "0")}`;
  } else {
    if (typeof value === "number" && !Number.isFinite(value)) return "—";
    text = String(value).trim();
    // Intl expands scientific notation for numeric chart values.
    if (typeof value === "number") text = value.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: decimals });
  }
  const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(text);
  if (!match) return "—";
  const [, sign, whole, fraction = ""] = match;
  const scale = 10n ** BigInt(decimals);
  let units = BigInt(whole) * scale + BigInt(fraction.slice(0, decimals).padEnd(decimals, "0") || "0");
  if (Number(fraction[decimals] ?? "0") >= 5) units += 1n;
  const integer = (units / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const places = Math.min(2, decimals);
  const tail = (units % scale).toString().padStart(decimals, "0").replace(/0+$/, "").padEnd(places, "0");
  return `${sign === "-" && units !== 0n ? "-" : ""}${integer}${tail ? `.${tail}` : ""} ${token}`;
}

/** Format percentage points (25 means 25%, not 2500%). */
export function formatPercent(value: number, fractionDigits = 1): string {
  if (!Number.isFinite(value) || !Number.isInteger(fractionDigits) || fractionDigits < 0 || fractionDigits > 100) return "—";
  const rounded = value.toFixed(fractionDigits);
  return `${Number(rounded) === 0 ? (0).toFixed(fractionDigits) : rounded}%`;
}

export function weightToPercent(weight: number, totalWeight: number): number {
  if (!Number.isFinite(weight) || !Number.isFinite(totalWeight) || totalWeight <= 0) {
    return 0;
  }
  return (weight / totalWeight) * 100;
}

export function formatWeightPercent(weight: number, totalWeight: number, fractionDigits = 1): string {
  return formatPercent(weightToPercent(weight, totalWeight), fractionDigits);
}

/** Numeric timestamps are Unix seconds; strings are ISO dates. Always render UTC. */
export function formatTimeSeriesLabel(
  timestamp: string | number | Date,
  granularity: "day" | "week" | "month" = "day",
): string {
  const date = timestamp instanceof Date ? timestamp : new Date(typeof timestamp === "number" ? timestamp * 1000 : timestamp);
  if (!Number.isFinite(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", {
    timeZone: "UTC", month: "short",
    ...(granularity === "month" ? { year: "numeric" as const } : { day: "numeric" as const }),
  });
}

/** Full UTC date for chart tooltips. */
export function formatAnalyticsDate(timestamp: string | number | Date): string {
  const date = timestamp instanceof Date ? timestamp : new Date(typeof timestamp === "number" ? timestamp * 1000 : timestamp);
  if (!Number.isFinite(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
}
