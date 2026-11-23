import { formatDeadline, safeBigInt, shortenAddress, stroopsToDisplay } from "./format";
import type { ApprovalState, Proposal, ProposalStatus } from "./types";

type RecordLike = Record<string, unknown>;

function asRecord(value: unknown): RecordLike | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : null;
}

/** Soroban unit enums decode either to a variant name or a single-key object. */
export function enumVariantName(raw: unknown, fallback: string): string {
  if (typeof raw === "string") return raw;
  const record = asRecord(raw);
  if (record) return Object.keys(record)[0] ?? fallback;
  return fallback;
}

export function mapStatus(raw: unknown): ProposalStatus {
  const status = enumVariantName(raw, "Pending").toLowerCase();
  switch (status) {
    case "ready":
    case "pending":
    case "executed":
    case "expired":
    case "revoked":
    case "cancelled":
      return status;
    default:
      return "pending";
  }
}

export interface MappedKind {
  kind: string;
  to: string;
  amount: string;
  token: string;
}

function firstTransfer(values: unknown[]): {
  to: unknown;
  token: unknown;
  amount: bigint;
} {
  const first = values[0];
  const record = asRecord(first);
  if (record && ("to" in record || "token" in record || "amount" in record)) {
    return {
      to: record.to,
      token: record.token,
      amount: safeBigInt(record.amount),
    };
  }
  // Legacy tuple shape used by older contract builds: [to, amount, token].
  return {
    to: first,
    amount: safeBigInt(values[1]),
    token: values[2],
  };
}

/**
 * Converts the decoded `ProposalKind` into display fields. Both the current
 * struct-based `Transfer(Vec<Transfer>)` payload and the older flat tuple are
 * accepted so the app can read any deployed Accord contract used by the web UI.
 */
export function mapKind(raw: unknown): MappedKind {
  const variant = enumVariantName(raw, "Transfer");
  const payloadValue = asRecord(raw)?.[variant];
  const values = Array.isArray(payloadValue)
    ? payloadValue
    : payloadValue === undefined
      ? []
      : [payloadValue];

  switch (variant.toLowerCase()) {
    case "transfer": {
      if (values.length === 0) {
        return { kind: "transfer", to: "Multiple", amount: "—", token: "Transfer" };
      }
      const transfer = firstTransfer(values);
      const isLegacyTuple =
        values.length === 3 &&
        typeof values[0] === "string" &&
        (typeof values[1] === "bigint" || typeof values[1] === "number") &&
        typeof values[2] === "string";
      const total = values.reduce((sum, entry) => {
        const record = asRecord(entry);
        return sum + (record ? safeBigInt(record.amount) : 0n);
      }, 0n);
      const amount = total !== 0n ? total : transfer.amount;
      return {
        kind: "transfer",
        to:
          values.length > 1 && !isLegacyTuple
            ? `${values.length} recipients`
            : shortenAddress(String(transfer.to ?? "Unknown")),
        amount: stroopsToDisplay(amount),
        token: shortenAddress(String(transfer.token ?? "Unknown")),
      };
    }
    case "addowner":
      return {
        kind: "add_owner",
        to: shortenAddress(String(values[0] ?? "Unknown")),
        amount: "—",
        token: "Add owner",
      };
    case "removeowner":
      return {
        kind: "remove_owner",
        to: shortenAddress(String(values[0] ?? "Unknown")),
        amount: "—",
        token: "Remove owner",
      };
    case "changethreshold":
      return {
        kind: "change_threshold",
        to: `${values[0] ?? "Unknown"} approvals`,
        amount: "—",
        token: "Threshold",
      };
    case "changeownerweight":
      return {
        kind: "change_owner_weight",
        to: shortenAddress(String(values[0] ?? "Unknown")),
        amount: String(values[1] ?? "—"),
        token: "Owner weight",
      };
    case "setspendinglimit":
    case "setspendinglimitwindow":
    case "settreasuryspendinglimit":
      return {
        kind: "set_spending_limit",
        to: shortenAddress(String(values[0] ?? "Treasury")),
        amount: stroopsToDisplay(safeBigInt(values[1] ?? values[2])),
        token: shortenAddress(String(values[1] ?? "Treasury")),
      };
    case "grantrole":
    case "revokerole":
      return {
        kind: variant.toLowerCase() === "grantrole" ? "grant_role" : "revoke_role",
        to: shortenAddress(String(values[0] ?? "Unknown")),
        amount: "—",
        token: enumVariantName(values[1], "Role"),
      };
    case "createrecurringpayment":
      return { kind: "recurring_payment", to: "Recurring payment", amount: "—", token: "Schedule" };
    case "pauserecurringpayment":
      return { kind: "pause_recurring_payment", to: "Recurring payment", amount: "—", token: "Pause" };
    case "resumerecurringpayment":
      return { kind: "resume_recurring_payment", to: "Recurring payment", amount: "—", token: "Resume" };
    case "cancelrecurringpayment":
      return { kind: "cancel_recurring_payment", to: "Recurring payment", amount: "—", token: "Cancel" };
    default:
      return { kind: variant.toLowerCase() || "other", to: "Unknown", amount: "—", token: variant };
  }
}

/** Mirrors `frontend/src/lib/contract.ts::mapProposal` for mobile consumers. */
export function mapProposal(
  raw: unknown,
  threshold: number,
  walletAddress?: string | null,
): Proposal {
  const record = asRecord(raw) ?? {};
  const details = mapKind(record.kind);
  const deadlineTs = Number(safeBigInt(record.deadline));
  const proposer = String(record.proposer ?? "");
  const approverAddresses = Array.isArray(record.approver_addresses)
    ? record.approver_addresses.map(String)
    : [];

  return {
    id: Number(safeBigInt(record.id)),
    kind: details.kind,
    to: details.to,
    amount: details.amount,
    token: details.token,
    description: String(record.description ?? ""),
    approvals: Number(safeBigInt(record.approvals)),
    approvalWeight: Number(safeBigInt(record.approval_weight ?? record.approvals)),
    quorumWeight: Number(safeBigInt(record.quorum_weight ?? threshold)),
    threshold,
    status: mapStatus(record.status),
    deadlineTs,
    proposer: shortenAddress(proposer),
    userHasApproved:
      Boolean(record.user_has_approved) ||
      (Boolean(walletAddress) && approverAddresses.includes(walletAddress as string)),
  };
}

export function mapApprovalState(raw: unknown, threshold = 0): ApprovalState {
  const record = asRecord(raw) ?? {};
  const values = Array.isArray(raw) ? raw : [];
  const asNumber = (value: unknown, fallback: number): number => {
    const parsed = Number(safeBigInt(value));
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    approvalWeight: asNumber(record.approval_weight ?? values[0], 0),
    quorumWeight: asNumber(record.quorum_weight ?? values[1], threshold),
    totalWeight: asNumber(record.total_weight ?? values[2], 0),
  };
}

export { formatDeadline };
