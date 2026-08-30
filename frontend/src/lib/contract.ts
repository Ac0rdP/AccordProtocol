import {
  Contract,
  rpc,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type { Proposal, ProposalKind, ProposalStatus } from "../types/accord";
import { stroopsToDisplay, formatDeadline, shortenAddr } from "./soroban";

const RPC_URL = import.meta.env.VITE_SOROBAN_RPC_URL as string;
const CONTRACT_ID = import.meta.env.VITE_CONTRACT_ADDRESS as string;
const NETWORK_PASSPHRASE = import.meta.env.VITE_NETWORK_PASSPHRASE as string;
// Any funded testnet account — used only to build simulation transactions (no signing).
const SIM_SOURCE = import.meta.env.VITE_SIM_SOURCE as string;

const server = new rpc.Server(RPC_URL);

async function simulateView(
  fn: string,
  args: xdr.ScVal[] = []
): Promise<xdr.ScVal> {
  const account = await server.getAccount(SIM_SOURCE);
  const contract = new Contract(CONTRACT_ID);
  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(fn, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim)) {
    const err = sim as rpc.Api.SimulateTransactionErrorResponse;
    throw new Error(`${fn}: ${err.error ?? "simulation failed"}`);
  }
  return (sim as rpc.Api.SimulateTransactionSuccessResponse).result!.retval;
}

function mapStatus(raw: unknown): ProposalStatus {
  if (typeof raw === "string") return raw.toLowerCase() as ProposalStatus;
  if (raw && typeof raw === "object") {
    const key = Object.keys(raw as object)[0] ?? "Pending";
    return key.toLowerCase() as ProposalStatus;
  }
  return "pending";
}

function safeBigInt(value: unknown): bigint {
  try {
    if (
      typeof value === "bigint" ||
      typeof value === "number" ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      return BigInt(value);
    }
    return 0n;
  } catch {
    return 0n;
  }
}

function mapKind(kind: unknown): { kind: ProposalKind; to: string; amount: string; token: string } {
  if (!kind || typeof kind !== "object") {
    return { kind: "transfer", to: "Unknown", amount: "0", token: "Unknown" };
  }

  const [variant, payload] = Object.entries(kind as Record<string, unknown>)[0] ?? [];
  const normalizedVariant = variant?.toLowerCase() ?? "";
  const values = Array.isArray(payload) ? payload : [payload];

  switch (normalizedVariant) {
    case "transfer":
      return {
        kind: "transfer",
        to: shortenAddr(String(values[0] ?? "Unknown")),
        amount: stroopsToDisplay(safeBigInt(values[1])),
        token: shortenAddr(String(values[2] ?? "Unknown")),
      };
    case "addowner":
      return {
        kind: "add_owner",
        to: shortenAddr(String(values[0] ?? "Unknown")),
        amount: "—",
        token: "Add owner",
      };
    case "removeowner":
      return {
        kind: "remove_owner",
        to: shortenAddr(String(values[0] ?? "Unknown")),
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
    case "setspendinglimit":
      return {
        kind: "set_spending_limit",
        to: shortenAddr(String(values[0] ?? "Unknown")),
        amount: stroopsToDisplay(safeBigInt(values[1])),
        token: shortenAddr(String(values[2] ?? "Unknown")),
      };
    case "changeownerweight":
      return {
        kind: "change_owner_weight",
        to: shortenAddr(String(values[0] ?? "Unknown")),
        amount: String(values[1] ?? "0"),
        token: "Weight",
      };
    default:
      return { kind: "transfer", to: "Unknown", amount: "0", token: "Unknown" };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapProposal(raw: any, threshold: number): Proposal {
  const rawDeadline = BigInt(raw.deadline);
  const mapped = mapKind(raw.kind);
  const quorumWeight = Number(raw.quorum_weight ?? threshold);

  return {
    id: Number(raw.id),
    kind: mapped.kind,
    to: mapped.to,
    amount: mapped.amount,
    token: mapped.token,
    description: String(raw.description),
    approvals: Number(raw.approvals),
    threshold: quorumWeight,
    status: mapStatus(raw.status),
    deadline: formatDeadline(rawDeadline),
    deadlineTs: Number(rawDeadline),
    createdAt: `proposal #${Number(raw.id)}`,
    proposer: shortenAddr(String(raw.proposer)),
    userHasApproved: false,
    approverAddresses: [],
    executedAt: formatDeadline(rawDeadline),
  };
}

export async function getOwners(): Promise<string[]> {
  const val = await simulateView("get_owners");
  return scValToNative(val) as string[];
}

export async function getThreshold(): Promise<number> {
  const val = await simulateView("get_threshold");
  return Number(scValToNative(val));
}

export async function getRequiredQuorumWeight(): Promise<number> {
  const val = await simulateView("get_required_quorum_weight");
  return Number(scValToNative(val));
}

export async function getTotalWeight(): Promise<number> {
  const val = await simulateView("get_total_weight");
  return Number(scValToNative(val));
}

export async function getOwnerWeight(owner: string): Promise<bigint> {
  try {
    const val = await simulateView("get_owner_weight", [
      nativeToScVal(owner, { type: "address" }),
    ]);
    const raw = scValToNative(val);
    return safeBigInt(raw);
  } catch {
    return 0n;
  }
}

export async function getSpendingLimit(owner: string, token: string): Promise<bigint> {
  try {
    const val = await simulateView("get_spending_limit", [
      nativeToScVal(owner, { type: "address" }),
      nativeToScVal(token, { type: "address" }),
    ]);
    const raw = scValToNative(val);
    return safeBigInt(raw);
  } catch {
    return -1n; // No limit record exists
  }
}

export async function getTotalProposals(): Promise<number> {
  const val = await simulateView("get_total_proposals");
  return Number(scValToNative(val));
}

export async function getProposalsPaged(
  offset: number,
  limit: number
): Promise<unknown[]> {
  const val = await simulateView("get_proposals_paged", [
    nativeToScVal(BigInt(offset), { type: "u64" }),
    nativeToScVal(limit, { type: "u32" }),
  ]);
  const result = scValToNative(val);
  return Array.isArray(result) ? result : [];
}

export async function getProposal(id: number): Promise<Proposal> {
  const [val, thresh] = await Promise.all([
    simulateView("get_proposal", [
      nativeToScVal(BigInt(id), { type: "u64" }),
    ]),
    getThreshold(),
  ]);
  return mapProposal(scValToNative(val), thresh);
}

export async function getProposalApprovalProgress(
  proposalId: number
): Promise<{ approvals: number; quorumWeight: number; totalWeight: number }> {
  const val = await simulateView("get_proposal_approval_progress", [
    nativeToScVal(BigInt(proposalId), { type: "u64" }),
  ]);
  const raw = scValToNative(val) as [unknown, unknown, unknown];
  return {
    approvals: Number(raw[0] ?? 0),
    quorumWeight: Number(raw[1] ?? 0),
    totalWeight: Number(raw[2] ?? 0),
  };
}

export async function hasApproved(
  walletAddress: string,
  proposalId: number
): Promise<boolean> {
  const val = await simulateView("has_approved", [
    nativeToScVal(walletAddress, { type: "address" }),
    nativeToScVal(BigInt(proposalId), { type: "u64" }),
  ]);
  return scValToNative(val) as boolean;
}

export async function getLatestLedger(): Promise<number> {
  try {
    const res = await server.getLatestLedger();
    return res.sequence;
  } catch (err) {
    console.error("Failed to get latest ledger:", err);
    throw err;
  }
}

export async function getContractEvents(fromLedger: number): Promise<number> {
  try {
    const res = await server.getEvents({
      startLedger: fromLedger,
      filters: [
        {
          type: "contract",
          contractIds: [CONTRACT_ID],
        },
      ],
      limit: 100,
    });
    return res.latestLedger || fromLedger;
  } catch (err) {
    console.error("Failed to get contract events:", err);
    return fromLedger;
  }
}

async function simulateContractView(
  contractId: string,
  fn: string,
  args: xdr.ScVal[] = []
): Promise<xdr.ScVal> {
  const account = await server.getAccount(SIM_SOURCE);
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(fn, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim)) {
    const err = sim as rpc.Api.SimulateTransactionErrorResponse;
    throw new Error(`${fn}: ${err.error ?? "simulation failed"}`);
  }
  return (sim as rpc.Api.SimulateTransactionSuccessResponse).result!.retval;
}

export async function getContractXlmBalance(): Promise<string> {
  const entry = await server.getAccountEntry(CONTRACT_ID);
  const stroops = BigInt(entry.balance().toString());
  return stroopsToDisplay(stroops);
}

export async function getContractUsdcBalance(): Promise<string> {
  const usdcToken = import.meta.env.VITE_USDC_TOKEN_ADDRESS as string;
  if (!usdcToken) return "N/A";
  try {
    const val = await simulateContractView(usdcToken, "balance", [
      nativeToScVal(CONTRACT_ID, { type: "address" }),
    ]);
    const raw = scValToNative(val);
    if (typeof raw === "bigint" || typeof raw === "number" || typeof raw === "string") {
      return stroopsToDisplay(BigInt(raw));
    }
    return "0";
  } catch {
    return "—";
  }
}

export async function getGuardian(): Promise<string> {
  try {
    const val = await simulateView("get_guardian");
    const raw = scValToNative(val);
    return String(raw);
  } catch {
    return "Unknown";
  }
}

export async function isFrozen(): Promise<boolean> {
  try {
    const val = await simulateView("is_frozen");
    const raw = scValToNative(val);
    return Boolean(raw);
  } catch {
    return false;
  }
}

export async function getApprovers(proposalId: number): Promise<string[]> {
  try {
    const owners = await getOwners();
    
    // Check all owners in parallel
    const checks = await Promise.all(
      owners.map(async (owner) => {
        const approved = await hasApproved(owner, proposalId);
        return { owner, approved };
      })
    );

    // Keep only the ones who approved
    return checks.filter((c) => c.approved).map((c) => c.owner);
  } catch (error) {
    console.error(`Failed to get approvers for proposal ${proposalId}:`, error);
    return [];
  }
}
