import { estimateCreateProposalFee, estimateCreateRecurringPaymentFee } from "./submit";
import { getTokenBalanceOf, getTreasuryTokenBalance } from "./contract";
import { stroopsToDisplay } from "./soroban";
import type { ProposalCategory } from "../types/accord";

export type BalanceDeltaRow = {
  /** "Treasury" or "Recipient" — who this balance belongs to. */
  label: string;
  /** Full address, when there is one to show (empty for the treasury's own row). */
  address: string;
  token: string;
  before: string;
  after: string;
};

export type TransactionPreview = {
  feeEstimate: number | null;
  /** Set when simulation failed; the caller should block submission while this is non-null. */
  feeError: string | null;
  balances: BalanceDeltaRow[];
};

function describeSimulationError(reason: unknown): string {
  return reason instanceof Error
    ? reason.message
    : "Transaction simulation failed. Please try again.";
}

/**
 * Simulates a transfer proposal's `create_proposal` call to estimate the
 * network fee, and reads the treasury's and recipient's current token
 * balances to compute the before/after delta the proposal would cause if
 * executed. The fee simulation is the "will this transaction even work"
 * check: a failure here is surfaced as `feeError` so the caller can block
 * submission on it.
 */
export async function previewTransferProposal({
  callerAddress,
  recipient,
  tokenAddress,
  tokenSymbol,
  amountStroops,
  description,
  deadlineUnix,
  category,
}: {
  callerAddress: string;
  recipient: string;
  tokenAddress: string;
  tokenSymbol: string;
  amountStroops: bigint;
  description: string;
  deadlineUnix: bigint;
  category?: ProposalCategory;
}): Promise<TransactionPreview> {
  const [feeResult, treasuryResult, recipientResult] = await Promise.allSettled([
    estimateCreateProposalFee(callerAddress, recipient, tokenAddress, amountStroops, description, deadlineUnix, category),
    getTreasuryTokenBalance(tokenAddress),
    getTokenBalanceOf(tokenAddress, recipient),
  ]);

  const feeEstimate = feeResult.status === "fulfilled" ? feeResult.value : null;
  const feeError = feeResult.status === "rejected" ? describeSimulationError(feeResult.reason) : null;

  const balances: BalanceDeltaRow[] = [];
  if (treasuryResult.status === "fulfilled") {
    const before = treasuryResult.value;
    const after = before - amountStroops;
    balances.push({
      label: "Treasury",
      address: "",
      token: tokenSymbol,
      before: stroopsToDisplay(before),
      after: stroopsToDisplay(after < 0n ? 0n : after),
    });
  }
  if (recipientResult.status === "fulfilled") {
    const before = recipientResult.value;
    const after = before + amountStroops;
    balances.push({
      label: "Recipient",
      address: recipient,
      token: tokenSymbol,
      before: stroopsToDisplay(before),
      after: stroopsToDisplay(after),
    });
  }

  return { feeEstimate, feeError, balances };
}

/**
 * Same idea as `previewTransferProposal`, but for a recurring-payment
 * proposal: the balance delta shown is the effect of the *first*
 * disbursement only (the one the contract would make on the schedule's
 * start date), not the schedule's full lifetime total.
 */
export async function previewRecurringPaymentProposal({
  callerAddress,
  recipient,
  tokenAddress,
  tokenSymbol,
  amountStroops,
  intervalSeconds,
  startTs,
  cliffTs,
  endTs,
  cap,
  category,
  kind,
}: {
  callerAddress: string;
  recipient: string;
  tokenAddress: string;
  tokenSymbol: string;
  amountStroops: bigint;
  intervalSeconds: bigint;
  startTs: bigint;
  cliffTs: bigint | null;
  endTs: bigint | null;
  cap: bigint | null;
  category: ProposalCategory;
  kind: "FixedAmountPerPeriod" | "LinearVesting";
}): Promise<TransactionPreview> {
  const [feeResult, treasuryResult, recipientResult] = await Promise.allSettled([
    estimateCreateRecurringPaymentFee(
      callerAddress, recipient, tokenAddress, amountStroops, intervalSeconds, startTs, cliffTs, endTs, cap, category, kind
    ),
    getTreasuryTokenBalance(tokenAddress),
    getTokenBalanceOf(tokenAddress, recipient),
  ]);

  const feeEstimate = feeResult.status === "fulfilled" ? feeResult.value : null;
  const feeError = feeResult.status === "rejected" ? describeSimulationError(feeResult.reason) : null;

  const balances: BalanceDeltaRow[] = [];
  if (treasuryResult.status === "fulfilled") {
    const before = treasuryResult.value;
    const after = before - amountStroops;
    balances.push({
      label: "Treasury (first disbursement)",
      address: "",
      token: tokenSymbol,
      before: stroopsToDisplay(before),
      after: stroopsToDisplay(after < 0n ? 0n : after),
    });
  }
  if (recipientResult.status === "fulfilled") {
    const before = recipientResult.value;
    const after = before + amountStroops;
    balances.push({
      label: "Recipient (first disbursement)",
      address: recipient,
      token: tokenSymbol,
      before: stroopsToDisplay(before),
      after: stroopsToDisplay(after),
    });
  }

  return { feeEstimate, feeError, balances };
}
