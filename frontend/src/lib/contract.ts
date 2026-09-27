import {
  Contract,
  rpc,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type {
  Proposal,
  ProposalCategory,
  ProposalEvent,
  ProposalEventType,
  ProposalKind,
  ProposalStatus,
} from "../types/accord";
import { stroopsToDisplay, formatDeadline, shortenAddr } from "./soroban";

const RPC_URL = (import.meta.env.VITE_SOROBAN_RPC_URL as string) || "https://soroban-testnet.stellar.org";
const CONTRACT_ID = (import.meta.env.VITE_CONTRACT_ADDRESS as string) || "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFFFFFF";
const NETWORK_PASSPHRASE = (import.meta.env.VITE_NETWORK_PASSPHRASE as string) || "Test SDF Network ; September 2015";
// Any funded testnet account — used only to build simulation transactions (no signing).
const SIM_SOURCE = (import.meta.env.VITE_SIM_SOURCE as string) || "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

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

function mapCategory(raw: unknown): ProposalCategory {
  // Soroban unit-enum variants decode either to their name as a string or to a
  // single-key object, so handle both shapes like mapStatus does. Anything
  // unrecognised (including an unset category) falls back to "other".
  let key: string;
  if (typeof raw === "string") {
    key = raw;
  } else if (raw && typeof raw === "object") {
    key = Object.keys(raw as object)[0] ?? "Other";
  } else {
    return "other";
  }
  switch (key.toLowerCase()) {
    case "transfer":
      return "transfer";
    case "payroll":
      return "payroll";
    case "grant":
      return "grant";
    case "ops":
      return "ops";
    default:
      return "other";
  }
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
    default:
      return { kind: "transfer", to: "Unknown", amount: "0", token: "Unknown" };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapProposal(raw: any, threshold: number): Proposal {
  const rawDeadline = BigInt(raw.deadline);
  const mapped = mapKind(raw.kind);

  return {
    id: Number(raw.id),
    kind: mapped.kind,
    category: mapCategory(raw.category),
    to: mapped.to,
    amount: mapped.amount,
    token: mapped.token,
    description: String(raw.description),
    approvals: Number(raw.approvals),
    threshold,
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

export async function getOwnerWeight(owner: string): Promise<number> {
  try {
    const val = await simulateView("get_owner_weight", [
      nativeToScVal(owner, { type: "address" }),
    ]);
    return Number(scValToNative(val));
  } catch {
    return 1;
  }
}

export async function getTotalWeight(): Promise<number> {
  try {
    const val = await simulateView("get_total_weight");
    return Number(scValToNative(val));
  } catch {
    return 0;
  }
}

export async function getRequiredQuorumWeight(): Promise<number> {
  try {
    const val = await simulateView("get_required_quorum_weight");
    return Number(scValToNative(val));
  } catch {
    return 0;
  }
}

export async function getWeightCapPct(): Promise<number> {
  try {
    const val = await simulateView("get_max_single_owner_weight_pct");
    return Number(scValToNative(val));
  } catch {
    return 50;
  }
}


export async function getThreshold(): Promise<number> {
  const val = await simulateView("get_threshold");
  return Number(scValToNative(val));
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
  const xlmToken = import.meta.env.VITE_XLM_TOKEN_ADDRESS as string;
  if (!xlmToken) return "N/A";
  try {
    const val = await simulateContractView(xlmToken, "balance", [
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

function parseScVal(val: unknown): unknown {
  if (!val) return null;
  if (typeof val === "string") {
    try {
      return scValToNative(xdr.ScVal.fromXDR(val, "base64"));
    } catch {
      return val;
    }
  }
  try {
    return scValToNative(val as xdr.ScVal);
  } catch {
    return val;
  }
}

function formatEventTimestamp(ledgerClosedAt?: string, ledger?: number): string {
  if (ledgerClosedAt) {
    const d = new Date(ledgerClosedAt);
    if (!isNaN(d.getTime())) {
      return d.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
    }
  }
  if (ledger) {
    return `Ledger #${ledger}`;
  }
  return "Just now";
}

export async function getProposalEvents(proposalId: number): Promise<ProposalEvent[]> {
  try {
    let startLedger = 1;
    try {
      const latest = await getLatestLedger();
      startLedger = Math.max(1, latest - 10000);
    } catch {
      startLedger = 1;
    }

    const res = await server.getEvents({
      startLedger,
      filters: [
        {
          type: "contract",
          contractIds: [CONTRACT_ID],
        },
      ],
      limit: 100,
    });

    const events: ProposalEvent[] = [];

    if (res.events && Array.isArray(res.events)) {
      for (const rawEv of res.events) {
        try {
          const rawTopic = Array.isArray(rawEv.topic) ? rawEv.topic : [rawEv.topic];
          const topics = rawTopic.map(parseScVal);
          const topicName = String(topics[0] ?? "").toLowerCase();

          if (topicName === "approved" || topicName === "revoked" || topicName === "executed") {
            const nativeValue = parseScVal(rawEv.value) as Record<string, unknown> | null;
            if (nativeValue && typeof nativeValue === "object") {
              const eventPropId = Number(nativeValue.id ?? -1);
              if (eventPropId === proposalId) {
                const rawActor = String(
                  nativeValue.approver ?? nativeValue.executor ?? nativeValue.actor ?? ""
                );
                const actor = rawActor ? shortenAddr(rawActor) : "Unknown";
                const timestamp = formatEventTimestamp(rawEv.ledgerClosedAt, rawEv.ledger);

                events.push({
                  type: topicName as ProposalEventType,
                  actor,
                  timestamp,
                  ledger: rawEv.ledger,
                });
              }
            }
          }
        } catch (evErr) {
          console.warn("Failed to parse event record:", evErr);
        }
      }
    }

    // Sort chronologically (oldest to newest)
    events.sort((a, b) => (a.ledger ?? 0) - (b.ledger ?? 0));
    return events;
  } catch (err) {
    console.error(`Failed to fetch events for proposal #${proposalId}:`, err);
    throw err;
  }
}

