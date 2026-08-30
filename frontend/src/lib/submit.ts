import {
  Contract,
  rpc,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type { Proposal, ProposalCategory, ProposalStatus } from "../types/accord";
import { stroopsToDisplay, formatDeadline, shortenAddr } from "./soroban";
import { signTx } from "./wallet";

const RPC_URL = import.meta.env.VITE_SOROBAN_RPC_URL as string;
const CONTRACT_ID = import.meta.env.VITE_CONTRACT_ADDRESS as string;
const NETWORK_PASSPHRASE = import.meta.env.VITE_NETWORK_PASSPHRASE as string;
// Any funded testnet account - used only to build simulation transactions (no signing).
const SIM_SOURCE = import.meta.env.VITE_SIM_SOURCE as string;

const server = new rpc.Server(RPC_URL);

async function buildAndSubmit(
  callerAddress: string,
  fn: string,
  args: xdr.ScVal[]
): Promise<void> {
  const account = await server.getAccount(callerAddress);
  const contract = new Contract(CONTRACT_ID);

  const tx = new TransactionBuilder(account, {
    fee: "100000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(fn, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim)) {
    const err = sim as rpc.Api.SimulateTransactionErrorResponse;
    throw new Error(`Simulation failed: ${err.error ?? "unknown"}`);
  }

  const assembled = rpc.assembleTransaction(tx, sim).build();
  const signed = await signTx(assembled.toXDR());
  if (!signed.ok) throw new Error(signed.error);

  const sent = await server.sendTransaction(
    TransactionBuilder.fromXDR(signed.value, NETWORK_PASSPHRASE)
  );

  if (sent.status === "ERROR") {
    throw new Error(`Submit failed: ${JSON.stringify(sent.errorResult)}`);
  }

  const hash = sent.hash;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const res = await server.getTransaction(hash);
    if (res.status === "SUCCESS") return;
    if (res.status === "FAILED") {
      throw new Error("Transaction failed on-chain");
    }
  }
  throw new Error("Transaction not confirmed within 30s");
}

async function simulateOnly(
  callerAddress: string,
  fn: string,
  args: xdr.ScVal[]
): Promise<number> {
  const account = await server.getAccount(callerAddress);
  const contract = new Contract(CONTRACT_ID);

  const tx = new TransactionBuilder(account, {
    fee: "100000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(fn, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim)) {
    const err = sim as rpc.Api.SimulateTransactionErrorResponse;
    throw new Error(`Simulation failed: ${err.error ?? "unknown"}`);
  }

  const minResourceFee = BigInt(sim.minResourceFee);
  const baseFee = 100000n;
  const totalStroops = baseFee + minResourceFee;
  return Number(totalStroops) / 10_000_000;
}

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

function mapKindDetails(
  kind: unknown
): Pick<Proposal, "kind" | "to" | "amount" | "token"> {
  if (!kind || typeof kind !== "object") {
    return {
      kind: "transfer",
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
        kind: "transfer",
        to: shortenAddr(String(values[0] ?? "Unknown")),
        amount: stroopsToDisplay(safeBigInt(values[1])),
        token: shortenAddr(String(values[2] ?? "Unknown")),
      };
    case "addowner":
      return {
        kind: "add_owner",
        to: shortenAddr(String(values[0] ?? "Unknown")),
        amount: "-",
        token: "Add owner",
      };
    case "removeowner":
      return {
        kind: "remove_owner",
        to: shortenAddr(String(values[0] ?? "Unknown")),
        amount: "-",
        token: "Remove owner",
      };
    case "changethreshold":
      return {
        kind: "change_threshold",
        to: `${values[0] ?? "Unknown"} approvals`,
        amount: "-",
        token: "Threshold",
      };
    case "setspendinglimit":
      return {
        kind: "set_spending_limit",
        to: shortenAddr(String(values[0] ?? "Unknown")),
        amount: String(values[2] ?? "Unknown"),
        token: shortenAddr(String(values[1] ?? "Unknown")),
      };
    case "changeownerweight":
      return {
        kind: "change_owner_weight",
        to: shortenAddr(String(values[0] ?? "Unknown")),
        amount: String(values[1] ?? "Unknown"),
        token: "Owner weight",
      };
    default:
      return {
        kind: "transfer",
        to: "Unknown",
        amount: "0",
        token: "Unknown",
      };
  }
}

function proposalCategoryScVal(category: ProposalCategory): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(category)]);
}

function optionalU64ScVal(value: bigint | null): xdr.ScVal {
  return value === null ? xdr.ScVal.scvVoid() : nativeToScVal(value, { type: "u64" });
}

function optionalI128ScVal(value: bigint | null): xdr.ScVal {
  return value === null ? xdr.ScVal.scvVoid() : nativeToScVal(value, { type: "i128" });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapProposal(raw: any, threshold: number): Proposal {
  const rawDeadline = BigInt(raw.deadline);
  const details = mapKindDetails(raw.kind);

  return {
    id: Number(raw.id),
    kind: details.kind,
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
    approverAddresses: [],
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

export async function getApprovers(proposalId: number): Promise<string[]> {
  try {
    const owners = await getOwners();

    const checks = await Promise.all(
      owners.map(async (owner) => {
        const approved = await hasApproved(owner, proposalId);
        return { owner, approved };
      })
    );

    return checks.filter((c) => c.approved).map((c) => c.owner);
  } catch (error) {
    console.error(`Failed to get approvers for proposal ${proposalId}:`, error);
    return [];
  }
}

export async function approveProposal(
  callerAddress: string,
  proposalId: number
): Promise<void> {
  await buildAndSubmit(callerAddress, "approve", [
    nativeToScVal(callerAddress, { type: "address" }),
    nativeToScVal(BigInt(proposalId), { type: "u64" }),
  ]);
}

export async function executeProposal(
  callerAddress: string,
  proposalId: number
): Promise<void> {
  await buildAndSubmit(callerAddress, "execute", [
    nativeToScVal(callerAddress, { type: "address" }),
    nativeToScVal(BigInt(proposalId), { type: "u64" }),
  ]);
}

export async function revokeProposal(
  callerAddress: string,
  proposalId: number
): Promise<void> {
  await buildAndSubmit(callerAddress, "revoke", [
    nativeToScVal(callerAddress, { type: "address" }),
    nativeToScVal(BigInt(proposalId), { type: "u64" }),
  ]);
}

export async function disburseRecurring(
  callerAddress: string,
  scheduleId: number
): Promise<void> {
  await buildAndSubmit(callerAddress, "disburse_recurring", [
    nativeToScVal(callerAddress, { type: "address" }),
    nativeToScVal(BigInt(scheduleId), { type: "u64" }),
  ]);
}

export async function createProposal(
  callerAddress: string,
  to: string,
  tokenAddress: string,
  amount: bigint,
  description: string,
  deadlineTs: bigint,
  category: ProposalCategory = "Transfer"
): Promise<void> {
  // Contract signature: create_proposal(proposer, to, amount, token, description, deadline, category)
  await buildAndSubmit(callerAddress, "create_proposal", [
    nativeToScVal(callerAddress, { type: "address" }),
    nativeToScVal(to, { type: "address" }),
    nativeToScVal(amount, { type: "i128" }),
    nativeToScVal(tokenAddress, { type: "address" }),
    xdr.ScVal.scvString(description),
    nativeToScVal(deadlineTs, { type: "u64" }),
    proposalCategoryScVal(category),
  ]);
}

export async function createDelegation(
  callerAddress: string,
  delegate: string,
  weight: number,
  expiryTs: bigint
): Promise<void> {
  // Contract signature: create_delegation(delegator, delegate, weight, expiry)
  await buildAndSubmit(callerAddress, "create_delegation", [
    nativeToScVal(callerAddress, { type: "address" }),
    nativeToScVal(delegate, { type: "address" }),
    nativeToScVal(weight, { type: "u32" }),
    nativeToScVal(expiryTs, { type: "u64" }),
  ]);
}

export async function createSpendingLimitProposal(
  callerAddress: string,
  owner: string,
  tokenAddress: string,
  amount: bigint,
  description: string,
  deadlineTs: bigint
): Promise<void> {
  await buildAndSubmit(callerAddress, "create_set_spending_limit_proposal", [
    nativeToScVal(callerAddress, { type: "address" }),
    nativeToScVal(owner, { type: "address" }),
    nativeToScVal(tokenAddress, { type: "address" }),
    nativeToScVal(amount, { type: "i128" }),
    xdr.ScVal.scvString(description),
    nativeToScVal(deadlineTs, { type: "u64" }),
  ]);
}

// ─── Guardian / emergency pause ─────────────────────────────────────────────

export async function freeze(
  callerAddress: string
): Promise<void> {
  await buildAndSubmit(callerAddress, "freeze", [
    nativeToScVal(callerAddress, { type: "address" }),
  ]);
}

export async function createSetGuardianProposal(
  callerAddress: string,
  newGuardian: string,
  description: string,
  deadlineTs: bigint
): Promise<void> {
  await buildAndSubmit(callerAddress, "create_set_guardian_proposal", [
    nativeToScVal(callerAddress, { type: "address" }),
    nativeToScVal(newGuardian, { type: "address" }),
    xdr.ScVal.scvString(description),
    nativeToScVal(deadlineTs, { type: "u64" }),
  ]);
}

export async function createUnfreezeProposal(
  callerAddress: string,
  description: string,
  deadlineTs: bigint
): Promise<void> {
  await buildAndSubmit(callerAddress, "create_unfreeze_proposal", [
    nativeToScVal(callerAddress, { type: "address" }),
    xdr.ScVal.scvString(description),
    nativeToScVal(deadlineTs, { type: "u64" }),
  ]);
}

// ─── Co-signature helpers ────────────────────────────────────────────────────

export async function buildAndAssembleTx(
  callerAddress: string,
  fn: string,
  args: xdr.ScVal[]
): Promise<string> {
  const account = await server.getAccount(callerAddress);
  const contract = new Contract(CONTRACT_ID);

  const tx = new TransactionBuilder(account, {
    fee: "100000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(fn, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim)) {
    const err = sim as rpc.Api.SimulateTransactionErrorResponse;
    throw new Error(`Simulation failed: ${err.error ?? "unknown"}`);
  }

  const assembled = rpc.assembleTransaction(tx, sim).build();
  return assembled.toXDR();
}

export async function signAndSubmitMultiSig(
  xdrStr: string,
  networkPassphrase?: string
): Promise<void> {
  const passphrase = networkPassphrase ?? NETWORK_PASSPHRASE;
  const signed = await signTx(xdrStr, passphrase.includes("Public") ? "PUBLIC" : "TESTNET");
  if (!signed.ok) throw new Error(signed.error);

  const tx = TransactionBuilder.fromXDR(signed.value, passphrase);
  const sent = await server.sendTransaction(tx);

  if (sent.status === "ERROR") {
    throw new Error(`Submit failed: ${JSON.stringify(sent.errorResult)}`);
  }

  const hash = sent.hash;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await server.getTransaction(hash);
    if (res.status === "SUCCESS") return;
    if (res.status === "FAILED") {
      throw new Error(`Transaction failed on-chain`);
    }
  }
  throw new Error("Transaction not confirmed within 60s");
}

export async function estimateCreateProposalFee(
  callerAddress: string,
  to: string,
  tokenAddress: string,
  amount: bigint,
  description: string,
  deadlineTs: bigint,
  category: ProposalCategory = "Transfer"
): Promise<number> {
  return await simulateOnly(callerAddress, "create_proposal", [
    nativeToScVal(callerAddress, { type: "address" }),
    nativeToScVal(to, { type: "address" }),
    nativeToScVal(amount, { type: "i128" }),
    nativeToScVal(tokenAddress, { type: "address" }),
    xdr.ScVal.scvString(description),
    nativeToScVal(deadlineTs, { type: "u64" }),
    proposalCategoryScVal(category),
  ]);
}

export async function createRecurringPaymentProposal(
  callerAddress: string,
  recipient: string,
  tokenAddress: string,
  amount: bigint,
  intervalSeconds: bigint,
  startTs: bigint,
  cliffTs: bigint | null,
  endTs: bigint | null,
  cap: bigint | null,
  category: ProposalCategory,
  kind: "FixedAmountPerPeriod" | "LinearVesting" = "FixedAmountPerPeriod"
): Promise<void> {
  await buildAndSubmit(callerAddress, "create_recurring_payment", [
    nativeToScVal(callerAddress, { type: "address" }),
    nativeToScVal(recipient, { type: "address" }),
    nativeToScVal(amount, { type: "i128" }),
    nativeToScVal(tokenAddress, { type: "address" }),
    nativeToScVal(intervalSeconds, { type: "u64" }),
    nativeToScVal(startTs, { type: "u64" }),
    optionalU64ScVal(cliffTs),
    optionalU64ScVal(endTs),
    optionalI128ScVal(cap),
    proposalCategoryScVal(category),
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(kind)]),
  ]);
}

export async function disburseRecurringPayment(
  callerAddress: string,
  scheduleId: number
): Promise<void> {
  await buildAndSubmit(callerAddress, "disburse_recurring", [
    nativeToScVal(BigInt(scheduleId), { type: "u64" }),
  ]);
}

export async function createCancelRecurringProposal(
  callerAddress: string,
  scheduleId: number,
  description: string,
  deadlineTs: bigint
): Promise<void> {
  await buildAndSubmit(callerAddress, "create_cancel_recurring_proposal", [
    nativeToScVal(callerAddress, { type: "address" }),
    nativeToScVal(BigInt(scheduleId), { type: "u64" }),
    xdr.ScVal.scvString(description),
    nativeToScVal(deadlineTs, { type: "u64" }),
  ]);
}

export async function createPauseRecurringProposal(
  callerAddress: string,
  scheduleId: number,
  description: string,
  deadlineTs: bigint
): Promise<void> {
  await buildAndSubmit(callerAddress, "create_pause_recurring_proposal", [
    nativeToScVal(callerAddress, { type: "address" }),
    nativeToScVal(BigInt(scheduleId), { type: "u64" }),
    xdr.ScVal.scvString(description),
    nativeToScVal(deadlineTs, { type: "u64" }),
  ]);
}

export async function createResumeRecurringProposal(
  callerAddress: string,
  scheduleId: number,
  description: string,
  deadlineTs: bigint
): Promise<void> {
  await buildAndSubmit(callerAddress, "create_resume_recurring_proposal", [
    nativeToScVal(callerAddress, { type: "address" }),
    nativeToScVal(BigInt(scheduleId), { type: "u64" }),
    xdr.ScVal.scvString(description),
    nativeToScVal(deadlineTs, { type: "u64" }),
  ]);
}

export async function createModifyRecurringProposal(
  callerAddress: string,
  scheduleId: number,
  newAmount: bigint,
  newIntervalSecs: bigint,
  description: string,
  deadlineTs: bigint
): Promise<void> {
  await buildAndSubmit(callerAddress, "create_modify_recurring_proposal", [
    nativeToScVal(callerAddress, { type: "address" }),
    nativeToScVal(BigInt(scheduleId), { type: "u64" }),
    nativeToScVal(newAmount, { type: "i128" }),
    nativeToScVal(newIntervalSecs, { type: "u64" }),
    xdr.ScVal.scvString(description),
    nativeToScVal(deadlineTs, { type: "u64" }),
  ]);
}

export async function createPauseRecurringProposal(
  callerAddress: string,
  scheduleId: number,
  description: string,
  deadlineTs: bigint
): Promise<void> {
  await buildAndSubmit(callerAddress, "create_pause_recurring_proposal", [
    nativeToScVal(callerAddress, { type: "address" }),
    nativeToScVal(BigInt(scheduleId), { type: "u64" }),
    xdr.ScVal.scvString(description),
    nativeToScVal(deadlineTs, { type: "u64" }),
  ]);
}

export async function createResumeRecurringProposal(
  callerAddress: string,
  scheduleId: number,
  description: string,
  deadlineTs: bigint
): Promise<void> {
  await buildAndSubmit(callerAddress, "create_resume_recurring_proposal", [
    nativeToScVal(callerAddress, { type: "address" }),
    nativeToScVal(BigInt(scheduleId), { type: "u64" }),
    xdr.ScVal.scvString(description),
    nativeToScVal(deadlineTs, { type: "u64" }),
  ]);
}

export async function createCancelRecurringProposal(
  callerAddress: string,
  scheduleId: number,
  description: string,
  deadlineTs: bigint
): Promise<void> {
  await buildAndSubmit(callerAddress, "create_cancel_recurring_proposal", [
    nativeToScVal(callerAddress, { type: "address" }),
    nativeToScVal(BigInt(scheduleId), { type: "u64" }),
    xdr.ScVal.scvString(description),
    nativeToScVal(deadlineTs, { type: "u64" }),
  ]);
}

export async function createModifyRecurringProposal(
  callerAddress: string,
  scheduleId: number,
  newAmount: bigint | null,
  newIntervalSecs: bigint | null,
  description: string,
  deadlineTs: bigint
): Promise<void> {
  await buildAndSubmit(callerAddress, "create_modify_recurring_proposal", [
    nativeToScVal(callerAddress, { type: "address" }),
    nativeToScVal(BigInt(scheduleId), { type: "u64" }),
    optionalI128ScVal(newAmount),
    optionalU64ScVal(newIntervalSecs),
    xdr.ScVal.scvString(description),
    nativeToScVal(deadlineTs, { type: "u64" }),
  ]);
}

// ─── Governance proposal creation ────────────────────────────────────────────

export async function createAddOwnerProposal(
  callerAddress: string,
  newOwner: string,
  description: string,
  deadlineTs: bigint
): Promise<void> {
  await buildAndSubmit(callerAddress, "create_add_owner_proposal", [
    nativeToScVal(callerAddress, { type: "address" }),
    nativeToScVal(newOwner, { type: "address" }),
    xdr.ScVal.scvString(description),
    nativeToScVal(deadlineTs, { type: "u64" }),
  ]);
}

export async function createRemoveOwnerProposal(
  callerAddress: string,
  ownerToRemove: string,
  description: string,
  deadlineTs: bigint
): Promise<void> {
  await buildAndSubmit(callerAddress, "create_remove_owner_proposal", [
    nativeToScVal(callerAddress, { type: "address" }),
    nativeToScVal(ownerToRemove, { type: "address" }),
    xdr.ScVal.scvString(description),
    nativeToScVal(deadlineTs, { type: "u64" }),
  ]);
}

export async function createChangeThresholdProposal(
  callerAddress: string,
  newThreshold: number,
  description: string,
  deadlineTs: bigint
): Promise<void> {
  await buildAndSubmit(callerAddress, "create_change_threshold_proposal", [
    nativeToScVal(callerAddress, { type: "address" }),
    nativeToScVal(newThreshold, { type: "u32" }),
    xdr.ScVal.scvString(description),
    nativeToScVal(deadlineTs, { type: "u64" }),
  ]);
}

export async function createChangeOwnerWeightProposal(
  callerAddress: string,
  targetOwner: string,
  newWeight: number,
  description: string,
  deadlineTs: bigint
): Promise<void> {
  await buildAndSubmit(callerAddress, "create_change_weight_proposal", [
    nativeToScVal(callerAddress, { type: "address" }),
    nativeToScVal(targetOwner, { type: "address" }),
    nativeToScVal(newWeight, { type: "u32" }),
    xdr.ScVal.scvString(description),
    nativeToScVal(deadlineTs, { type: "u64" }),
  ]);
}

