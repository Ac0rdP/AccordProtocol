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

export function weightToPercent(weight: number, totalWeight: number): number {
  if (totalWeight === 0) return 0;
  return (weight / totalWeight) * 100;
}

export function formatWeightPercent(weight: number, totalWeight: number): string {
  return `${weightToPercent(weight, totalWeight).toFixed(1)}%`;
}

const CONTRACT_ERRORS: Record<string, string> = {
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

