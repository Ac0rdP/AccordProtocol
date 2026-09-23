import {
  Contract,
  rpc,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type {
  Delegation,
  OwnerDelegations,
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
    case "grantrole":
      return {
        kind: "grant_role",
        to: shortenAddr(String(values[0] ?? "Unknown")),
        amount: "—",
        token: String(values[1] ?? "Role"),
      };
    case "revokerole":
      return {
        kind: "revoke_role",
        to: shortenAddr(String(values[0] ?? "Unknown")),
        amount: "—",
        token: String(values[1] ?? "Role"),
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
    quorumWeight: Number(raw.quorum_weight ?? threshold),
    approvalWeight: Number(raw.approval_weight ?? raw.approvals ?? 0),
    totalWeight: 0,
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapDelegation(raw: any): Delegation {
  const expiryTs = Number(safeBigInt(raw.expiry));
  return {
    delegator: String(raw.delegator),
    delegate: String(raw.delegate),
    weight: Number(raw.weight ?? 0),
    expiry: formatDeadline(safeBigInt(raw.expiry)),
    expiryTs,
    active: expiryTs * 1000 > Date.now(),
  };
}

// Returns `owner`'s outgoing delegation (if any) alongside every delegation
// they currently receive from other owners.
export async function getDelegations(owner: string): Promise<OwnerDelegations> {
  try {
    const val = await simulateView("get_delegations", [
      nativeToScVal(owner, { type: "address" }),
    ]);
    const raw = scValToNative(val) as { outgoing?: unknown; incoming?: unknown[] };
    return {
      outgoing: raw?.outgoing ? mapDelegation(raw.outgoing) : null,
      incoming: Array.isArray(raw?.incoming) ? raw.incoming.map(mapDelegation) : [],
    };
  } catch {
    return { outgoing: null, incoming: [] };
  }
}

// Returns every owner's outgoing delegation that has not yet expired.
export async function getActiveDelegations(): Promise<Delegation[]> {
  try {
    const val = await simulateView("get_active_delegations");
    const raw = scValToNative(val);
    return Array.isArray(raw) ? raw.map(mapDelegation) : [];
  } catch {
    return [];
  }
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

export async function getOwnerWeights(): Promise<Array<{ address: string; weight: number }>> {
  try {
    const val = await simulateView("get_owner_weights");
    const raw = scValToNative(val) as Array<{ owner?: string; address?: string; weight?: number }>;
    return (raw ?? []).map((entry) => ({
      address: String(entry.owner ?? entry.address ?? ""),
      weight: Number(entry.weight ?? 0),
    }));
  } catch {
    return [];
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

export async function getProposalApprovalProgress(
  proposalId: number,
): Promise<{ approvalWeight: number; quorumWeight: number; totalWeight: number }> {
  try {
    const val = await simulateView("get_proposal_approval_progress", [
      nativeToScVal(BigInt(proposalId), { type: "u64" }),
    ]);
    const raw = scValToNative(val) as {
      approval_weight?: number;
      quorum_weight?: number;
      total_weight?: number;
    };
    return {
      approvalWeight: Number(raw.approval_weight ?? 0),
      quorumWeight: Number(raw.quorum_weight ?? 0),
      totalWeight: Number(raw.total_weight ?? 0),
    };
  } catch (error) {
    console.error(`Failed to get approval progress for proposal ${proposalId}:`, error);
    throw error;
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

function resolveEventType(first: string, second: string): ProposalEventType | null {
  const normFirst = first.replace(/_/g, "");
  const normSecond = second.replace(/_/g, "");

  if (normFirst === "approved" || normFirst === "proposalapproved" || normFirst === "approve") {
    return "approved";
  }
  if (normFirst === "revoked" || normFirst === "proposalrevoked" || normFirst === "revoke") {
    return "revoked";
  }
  if (normFirst === "executed" || normFirst === "proposalexecuted" || normFirst === "execute") {
    return "executed";
  }
  if (
    normFirst === "ownerweightchanged" ||
    normFirst === "cwgt" ||
    normFirst === "ownerweightchange"
  ) {
    return "owner_weight_changed";
  }
  if (
    normFirst === "recurringpaymentcreated" ||
    normFirst === "recurringcreated" ||
    normFirst === "reccreate" ||
    normFirst === "reccreated" ||
    normFirst === "recpmtcreated" ||
    normFirst === "schedulecreated" ||
    ((normFirst.includes("recurring") || normFirst.includes("schedule")) &&
      (normFirst.includes("create") || normSecond.includes("create")))
  ) {
    return "recurring_payment_created";
  }
  if (
    normFirst === "recurringpaymentdisbursed" ||
    normFirst === "recurringdisbursed" ||
    normFirst === "recdisburse" ||
    normFirst === "recdisbursed" ||
    normFirst === "recpmtdisbursed" ||
    normFirst === "scheduledisbursed" ||
    normFirst === "disbursed" ||
    normFirst === "disburse" ||
    ((normFirst.includes("recurring") || normFirst.includes("schedule")) &&
      (normFirst.includes("disburs") || normSecond.includes("disburs")))
  ) {
    return "recurring_payment_disbursed";
  }
  if (
    normFirst === "recurringpaymentpaused" ||
    normFirst === "recurringpaused" ||
    normFirst === "recpause" ||
    normFirst === "recpaused" ||
    normFirst === "recpmtpaused" ||
    normFirst === "schedulepaused" ||
    normFirst === "paused" ||
    normFirst === "pause" ||
    ((normFirst.includes("recurring") || normFirst.includes("schedule")) &&
      (normFirst.includes("pause") || normSecond.includes("pause")))
  ) {
    return "recurring_payment_paused";
  }
  if (
    normFirst === "recurringpaymentcancelled" ||
    normFirst === "recurringpaymentcanceled" ||
    normFirst === "recurringcancelled" ||
    normFirst === "recurringcanceled" ||
    normFirst === "reccancel" ||
    normFirst === "reccancelled" ||
    normFirst === "reccanceled" ||
    normFirst === "recpmtcancelled" ||
    normFirst === "recpmtcanceled" ||
    normFirst === "schedulecancelled" ||
    normFirst === "schedulecanceled" ||
    normFirst === "cancelled" ||
    normFirst === "canceled" ||
    normFirst === "cancel" ||
    ((normFirst.includes("recurring") || normFirst.includes("schedule")) &&
      (normFirst.includes("cancel") || normSecond.includes("cancel")))
  ) {
    return "recurring_payment_cancelled";
  }
  return null;
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
          const firstTopic = String(topics[0] ?? "").toLowerCase();
          const secondTopic = topics.length > 1 ? String(topics[1] ?? "").toLowerCase() : "";

          const nativeValue = parseScVal(rawEv.value) as Record<string, unknown> | null;
          let eventType = resolveEventType(firstTopic, secondTopic);
          if (!eventType && nativeValue && typeof nativeValue === "object") {
            const innerType = String(nativeValue.event ?? nativeValue.type ?? "").toLowerCase();
            eventType = resolveEventType(innerType, "");
          }

          if (eventType && nativeValue && typeof nativeValue === "object") {
            let eventPropId: number | null = null;
            if (nativeValue.proposal_id !== undefined && nativeValue.proposal_id !== null) {
              eventPropId = Number(nativeValue.proposal_id);
            } else if (nativeValue.proposalId !== undefined && nativeValue.proposalId !== null) {
              eventPropId = Number(nativeValue.proposalId);
            } else if (nativeValue.proposal !== undefined && nativeValue.proposal !== null) {
              eventPropId = Number(nativeValue.proposal);
            } else if (nativeValue.id !== undefined && nativeValue.id !== null) {
              eventPropId = Number(nativeValue.id);
            } else if (nativeValue.schedule_id !== undefined && nativeValue.schedule_id !== null) {
              eventPropId = Number(nativeValue.schedule_id);
            } else if (nativeValue.scheduleId !== undefined && nativeValue.scheduleId !== null) {
              eventPropId = Number(nativeValue.scheduleId);
            } else if (nativeValue.schedule !== undefined && nativeValue.schedule !== null) {
              eventPropId = Number(nativeValue.schedule);
            } else if (topics.length > 1 && !isNaN(Number(topics[1]))) {
              eventPropId = Number(topics[1]);
            }

            if (eventPropId === proposalId) {
              const rawActor = String(
                nativeValue.approver ??
                  nativeValue.executor ??
                  nativeValue.actor ??
                  nativeValue.proposer ??
                  nativeValue.caller ??
                  nativeValue.sender ??
                  nativeValue.admin ??
                  nativeValue.owner ??
                  ""
              );
              const actor = rawActor ? shortenAddr(rawActor) : "Unknown";
              const timestamp = formatEventTimestamp(rawEv.ledgerClosedAt, rawEv.ledger);

              const rawScheduleId =
                nativeValue.schedule_id ??
                nativeValue.scheduleId ??
                nativeValue.schedule ??
                nativeValue.schedule_number ??
                (nativeValue.proposal_id !== undefined || nativeValue.proposalId !== undefined
                  ? nativeValue.id
                  : undefined) ??
                (topics.length > 2 && !isNaN(Number(topics[2])) ? Number(topics[2]) : undefined);

              const scheduleId =
                rawScheduleId !== undefined && rawScheduleId !== null
                  ? typeof rawScheduleId === "bigint" || typeof rawScheduleId === "number"
                    ? Number(rawScheduleId)
                    : String(rawScheduleId)
                  : eventType.startsWith("recurring_payment") && nativeValue.id !== undefined
                  ? Number(nativeValue.id)
                  : undefined;

              const rawAmount =
                nativeValue.amount ??
                nativeValue.disbursed_amount ??
                nativeValue.disbursement_amount ??
                nativeValue.payment_amount;

              let amount: string | undefined;
              if (rawAmount !== undefined && rawAmount !== null) {
                if (typeof rawAmount === "bigint") {
                  amount = stroopsToDisplay(rawAmount);
                } else if (typeof rawAmount === "number") {
                  amount =
                    rawAmount >= 10_000_000
                      ? stroopsToDisplay(BigInt(Math.round(rawAmount)))
                      : String(rawAmount);
                } else if (typeof rawAmount === "string") {
                  if (/^\d{8,}$/.test(rawAmount)) {
                    amount = stroopsToDisplay(BigInt(rawAmount));
                  } else {
                    amount = rawAmount;
                  }
                }
              }

              const rawToken = nativeValue.token ?? nativeValue.asset;
              const token = rawToken
                ? String(rawToken).length > 12
                  ? shortenAddr(String(rawToken))
                  : String(rawToken)
                : undefined;

              const rawRecipient =
                nativeValue.recipient ?? nativeValue.to ?? nativeValue.beneficiary;
              const recipient = rawRecipient ? shortenAddr(String(rawRecipient)) : undefined;

              const reason = nativeValue.reason ? String(nativeValue.reason) : undefined;

              let details: string | undefined;
              if (eventType === "recurring_payment_created") {
                const parts: string[] = [];
                if (scheduleId !== undefined) parts.push(`Schedule #${scheduleId}`);
                if (amount) parts.push(token ? `${amount} ${token}` : amount);
                if (recipient) parts.push(`to ${recipient}`);
                if (parts.length > 0) details = parts.join(" · ");
              } else if (eventType === "recurring_payment_disbursed") {
                const parts: string[] = [];
                if (scheduleId !== undefined) parts.push(`Schedule #${scheduleId}`);
                if (amount) parts.push(token ? `${amount} ${token}` : amount);
                if (recipient) parts.push(`to ${recipient}`);
                if (parts.length > 0) details = parts.join(" · ");
              } else if (eventType === "recurring_payment_paused") {
                const parts: string[] = [];
                if (scheduleId !== undefined) parts.push(`Schedule #${scheduleId}`);
                if (reason) parts.push(reason);
                if (parts.length > 0) details = parts.join(" · ");
              } else if (eventType === "recurring_payment_cancelled") {
                const parts: string[] = [];
                if (scheduleId !== undefined) parts.push(`Schedule #${scheduleId}`);
                if (reason) parts.push(reason);
                if (parts.length > 0) details = parts.join(" · ");
              } else if (eventType === "owner_weight_changed") {
                if (nativeValue.old_weight !== undefined && nativeValue.new_weight !== undefined) {
                  details = `Weight: ${nativeValue.old_weight} → ${nativeValue.new_weight}`;
                }
              }

              events.push({
                type: eventType,
                actor,
                timestamp,
                ledger: rawEv.ledger,
                scheduleId,
                amount,
                token,
                recipient,
                details,
              });
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

export async function getRoleVersion(): Promise<string> {
  try {
    const val = await simulateView("get_role_version");
    const versionNum = scValToNative(val);
    return `v${versionNum ?? 1}`;
  } catch {
    return "v1";
  }
}

export async function getRoles(walletAddress: string | null): Promise<string[]> {
  if (!walletAddress) return [];
  try {
    const val = await simulateView("get_roles", [
      nativeToScVal(walletAddress, { type: "address" }),
    ]);
    const rawRoles = scValToNative(val);
    if (Array.isArray(rawRoles) && rawRoles.length > 0) {
      return rawRoles.map((r: unknown) => String(r));
    }
  } catch {
    // Ignore error and use fallback
  }

  try {
    const owners = await getOwners();
    if (owners.includes(walletAddress)) {
      return ["Owner", "Approver"];
    }
  } catch {
    // Fallback if getOwners fails
  }
  return [];
}

