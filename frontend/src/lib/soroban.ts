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
  "25": "Owner not found."
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
