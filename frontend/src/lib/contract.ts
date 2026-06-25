import {
  Contract,
  rpc,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type { Proposal, ProposalStatus } from "../types/accord";
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

function mapKindDetails(kind: unknown): Pick<Proposal, "to" | "amount" | "token"> {
  if (!kind || typeof kind !== "object") {
    return {
      to: "Unknown",
      amount: "0",
      token: "Unknown",
    };
  }

  const [variant, payload] = Object.entries(kind as Record<string, unknown>)[0] ?? [];
  const normalizedVariant = variant?.toLowerCase() ?? "";
  const values = Array.isArray(payload) ? payload : [payload];

  switch (normalizedVariant) {
    case "transfer":
      return {
        to: shortenAddr(String(values[0] ?? "Unknown")),
        amount: stroopsToDisplay(safeBigInt(values[1])),
        token: shortenAddr(String(values[2] ?? "Unknown")),
      };
    case "addowner":
      return {
        to: shortenAddr(String(values[0] ?? "Unknown")),
        amount: "—",
        token: "Add owner",
      };
    case "removeowner":
      return {
        to: shortenAddr(String(values[0] ?? "Unknown")),
        amount: "—",
        token: "Remove owner",
      };
    case "changethreshold":
      return {
        to: `${values[0] ?? "Unknown"} approvals`,
        amount: "—",
        token: "Threshold",
      };
    default:
      return {
        to: "Unknown",
        amount: "0",
        token: "Unknown",
      };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapProposal(raw: any, threshold: number): Proposal {
  const rawDeadline = BigInt(raw.deadline);
  const details = mapKindDetails(raw.kind);

  return {
    id: Number(raw.id),
    to: details.to,
    amount: details.amount,
    token: details.token,
    description: String(raw.description),
    approvals: Number(raw.approvals),
    threshold,
    status: mapStatus(raw.status),
    deadline: formatDeadline(rawDeadline),
    deadlineTs: Number(rawDeadline),
    createdAt: `proposal #${Number(raw.id)}`,
    proposer: shortenAddr(String(raw.proposer)),
    userHasApproved: false,
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
