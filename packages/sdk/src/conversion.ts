/**
 * XDR Encoding and Decoding Utilities for Accord Protocol SDK
 * Grounded in contracts/accord/src/lib.rs
 */

import {
  Address,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type {
  AssetReference,
  AssetTransfer,
  CreateRecurringParams,
  Delegation,
  DelegationInfo,
  ModifyRecurringParams,
  OwnerWeight,
  Proposal,
  ProposalApprovalProgress,
  ProposalCategory,
  ProposalKind,
  ProposalStatus,
  RecurringKind,
  RecurringPayment,
  RecurringStatus,
  Role,
  SpendingLimitEntry,
  SpentTracker,
  Transfer,
} from "./types.js";

// ─── Encoding Helpers ─────────────────────────────────────────────────────────

export function addressToScVal(addr: string): xdr.ScVal {
  return new Address(addr).toScVal();
}

export function u32ToScVal(val: number): xdr.ScVal {
  return xdr.ScVal.scvU32(val);
}

export function u64ToScVal(val: bigint | number): xdr.ScVal {
  return nativeToScVal(BigInt(val), { type: "u64" });
}

export function i128ToScVal(val: bigint | number): xdr.ScVal {
  return nativeToScVal(BigInt(val), { type: "i128" });
}

export function symbolToScVal(sym: string): xdr.ScVal {
  return xdr.ScVal.scvSymbol(sym);
}

export function stringToScVal(str: string): xdr.ScVal {
  return xdr.ScVal.scvString(str);
}

export function boolToScVal(val: boolean): xdr.ScVal {
  return xdr.ScVal.scvBool(val);
}

export function bytes32ToScVal(hash: string | Uint8Array): xdr.ScVal {
  let buf: Buffer;
  if (typeof hash === "string") {
    const cleanHex = hash.startsWith("0x") ? hash.slice(2) : hash;
    buf = Buffer.from(cleanHex, "hex");
  } else {
    buf = Buffer.from(hash);
  }
  if (buf.length !== 32) {
    throw new Error(`bytes32 must be exactly 32 bytes (got ${buf.length}).`);
  }
  return xdr.ScVal.scvBytes(buf);
}

export function optionalBytes32ToScVal(hash?: string | Uint8Array | null): xdr.ScVal {
  if (!hash) {
    return xdr.ScVal.scvVoid();
  }
  return bytes32ToScVal(hash);
}

export function categoryToScVal(cat: ProposalCategory): xdr.ScVal {
  return symbolToScVal(cat);
}

export function roleToScVal(role: Role): xdr.ScVal {
  return symbolToScVal(role);
}

export function transferToScVal(t: Transfer): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("amount"),
      val: i128ToScVal(t.amount),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("to"),
      val: addressToScVal(t.to),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("token"),
      val: addressToScVal(t.token),
    }),
  ]);
}

export function transfersToScVal(transfers: Transfer[]): xdr.ScVal {
  return xdr.ScVal.scvVec(transfers.map(transferToScVal));
}

export function assetTransferToScVal(at: AssetTransfer): xdr.ScVal {
  let assetScVal: xdr.ScVal;
  if ("Address" in at.asset) {
    assetScVal = xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol("Address"),
      addressToScVal(at.asset.Address),
    ]);
  } else {
    assetScVal = xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol("Classic"),
      symbolToScVal(at.asset.Classic),
    ]);
  }

  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("amount"),
      val: i128ToScVal(at.amount),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("asset"),
      val: assetScVal,
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("to"),
      val: addressToScVal(at.to),
    }),
  ]);
}

export function assetTransfersToScVal(transfers: AssetTransfer[]): xdr.ScVal {
  return xdr.ScVal.scvVec(transfers.map(assetTransferToScVal));
}

export function createRecurringParamsToScVal(p: CreateRecurringParams): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("amount"), val: i128ToScVal(p.amount) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("cliff_time"), val: u64ToScVal(p.cliff_time) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("end_time"), val: u64ToScVal(p.end_time) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("interval_secs"), val: u64ToScVal(p.interval_secs) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("kind"), val: symbolToScVal(p.kind) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("recipient"), val: addressToScVal(p.recipient) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("start_time"), val: u64ToScVal(p.start_time) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("token"), val: addressToScVal(p.token) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("total_cap"), val: i128ToScVal(p.total_cap) }),
  ]);
}

export function modifyRecurringParamsToScVal(p: ModifyRecurringParams): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("new_amount"),
      val: p.new_amount !== undefined && p.new_amount !== null ? i128ToScVal(p.new_amount) : xdr.ScVal.scvVoid(),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("new_end_time"),
      val: p.new_end_time !== undefined && p.new_end_time !== null ? u64ToScVal(p.new_end_time) : xdr.ScVal.scvVoid(),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("new_interval_secs"),
      val: p.new_interval_secs !== undefined && p.new_interval_secs !== null ? u64ToScVal(p.new_interval_secs) : xdr.ScVal.scvVoid(),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("schedule_id"),
      val: u64ToScVal(p.schedule_id),
    }),
  ]);
}

export function ownerWeightsToScVal(weights: OwnerWeight[]): xdr.ScVal {
  return xdr.ScVal.scvVec(
    weights.map((w) =>
      xdr.ScVal.scvMap([
        new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("owner"), val: addressToScVal(w.owner) }),
        new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("weight"), val: u32ToScVal(w.weight) }),
      ])
    )
  );
}

// ─── Decoding Helpers ─────────────────────────────────────────────────────────

export function scValToBigInt(scVal: xdr.ScVal): bigint {
  const native = scValToNative(scVal);
  if (typeof native === "bigint") return native;
  if (typeof native === "number") return BigInt(native);
  if (typeof native === "string") return BigInt(native);
  return 0n;
}

export function scValToNumber(scVal: xdr.ScVal): number {
  const native = scValToNative(scVal);
  if (typeof native === "number") return native;
  if (typeof native === "bigint") return Number(native);
  return Number(native) || 0;
}

export function scValToBool(scVal: xdr.ScVal): boolean {
  return Boolean(scValToNative(scVal));
}

export function scValToString(scVal: xdr.ScVal): string {
  const native = scValToNative(scVal);
  return String(native ?? "");
}

export function scValToAddress(scVal: xdr.ScVal): string {
  const native = scValToNative(scVal);
  return String(native ?? "");
}

export function scValToAddressList(scVal: xdr.ScVal): string[] {
  const native = scValToNative(scVal);
  if (Array.isArray(native)) {
    return native.map(String);
  }
  return [];
}

export function scValToProposal(scVal: xdr.ScVal): Proposal {
  const raw = scValToNative(scVal) as Record<string, unknown>;

  let status: ProposalStatus = "Pending";
  if (typeof raw.status === "string") {
    status = raw.status as ProposalStatus;
  } else if (raw.status && typeof raw.status === "object") {
    status = Object.keys(raw.status)[0] as ProposalStatus;
  }

  let category: ProposalCategory = "Other";
  if (typeof raw.category === "string") {
    category = raw.category as ProposalCategory;
  } else if (raw.category && typeof raw.category === "object") {
    category = Object.keys(raw.category)[0] as ProposalCategory;
  }

  let attachmentHash: string | null = null;
  if (raw.attachment_hash) {
    if (Buffer.isBuffer(raw.attachment_hash) || raw.attachment_hash instanceof Uint8Array) {
      attachmentHash = Buffer.from(raw.attachment_hash).toString("hex");
    } else {
      attachmentHash = String(raw.attachment_hash);
    }
  }

  return {
    id: BigInt(String(raw.id ?? "0")),
    proposer: String(raw.proposer ?? ""),
    description: String(raw.description ?? ""),
    deadline: BigInt(String(raw.deadline ?? "0")),
    approvals: Number(raw.approvals ?? 0),
    approval_weight: Number(raw.approval_weight ?? 0),
    status,
    kind: (raw.kind ?? { Transfer: [] }) as ProposalKind,
    ready_at: BigInt(String(raw.ready_at ?? "0")),
    quorum_weight: Number(raw.quorum_weight ?? 0),
    category,
    attachment_hash: attachmentHash,
  };
}

export function scValToRecurringPayment(scVal: xdr.ScVal): RecurringPayment {
  const raw = scValToNative(scVal) as Record<string, unknown>;

  let status: RecurringStatus = "Active";
  if (typeof raw.status === "string") {
    status = raw.status as RecurringStatus;
  } else if (raw.status && typeof raw.status === "object") {
    status = Object.keys(raw.status)[0] as RecurringStatus;
  }

  let kind: RecurringKind = "FixedAmountPerPeriod";
  if (typeof raw.kind === "string") {
    kind = raw.kind as RecurringKind;
  } else if (raw.kind && typeof raw.kind === "object") {
    kind = Object.keys(raw.kind)[0] as RecurringKind;
  }

  let category: ProposalCategory = "Other";
  if (typeof raw.category === "string") {
    category = raw.category as ProposalCategory;
  } else if (raw.category && typeof raw.category === "object") {
    category = Object.keys(raw.category)[0] as ProposalCategory;
  }

  return {
    id: BigInt(String(raw.id ?? "0")),
    proposer: String(raw.proposer ?? ""),
    recipient: String(raw.recipient ?? ""),
    token: String(raw.token ?? ""),
    amount: BigInt(String(raw.amount ?? "0")),
    interval_secs: BigInt(String(raw.interval_secs ?? "0")),
    start_time: BigInt(String(raw.start_time ?? "0")),
    end_time: BigInt(String(raw.end_time ?? "0")),
    cliff_time: BigInt(String(raw.cliff_time ?? "0")),
    total_cap: BigInt(String(raw.total_cap ?? "0")),
    total_disbursed: BigInt(String(raw.total_disbursed ?? "0")),
    last_disbursed_at: BigInt(String(raw.last_disbursed_at ?? "0")),
    periods_disbursed: Number(raw.periods_disbursed ?? 0),
    status,
    kind,
    category,
    description: String(raw.description ?? ""),
  };
}

export function scValToDelegationInfo(scVal: xdr.ScVal): DelegationInfo {
  const raw = scValToNative(scVal) as { outgoing?: unknown[]; incoming?: unknown[] };

  const mapDelegation = (d: any): Delegation => ({
    delegator: String(d.delegator ?? ""),
    delegate: String(d.delegate ?? ""),
    weight: Number(d.weight ?? 0),
    expiry: d.expiry ? BigInt(String(d.expiry)) : null,
  });

  return {
    outgoing: Array.isArray(raw.outgoing) ? raw.outgoing.map(mapDelegation) : [],
    incoming: Array.isArray(raw.incoming) ? raw.incoming.map(mapDelegation) : [],
  };
}

export function scValToOwnerWeights(scVal: xdr.ScVal): OwnerWeight[] {
  const raw = scValToNative(scVal);
  if (!Array.isArray(raw)) return [];
  return raw.map((entry: any) => ({
    owner: String(entry.owner ?? ""),
    weight: Number(entry.weight ?? 0),
  }));
}

export function scValToSpendingLimits(scVal: xdr.ScVal): SpendingLimitEntry[] {
  const raw = scValToNative(scVal);
  if (!Array.isArray(raw)) return [];
  return raw.map((entry: any) => ({
    token: String(entry.token ?? ""),
    limit: BigInt(String(entry.limit ?? "0")),
  }));
}

export function scValToSpentTracker(scVal: xdr.ScVal): SpentTracker {
  const raw = scValToNative(scVal) as Record<string, unknown>;
  return {
    spent: BigInt(String(raw.spent ?? "0")),
    epoch: BigInt(String(raw.epoch ?? "0")),
  };
}

export function scValToProposalApprovalProgress(scVal: xdr.ScVal): ProposalApprovalProgress {
  const raw = scValToNative(scVal) as Record<string, unknown>;
  return {
    approval_weight: Number(raw.approval_weight ?? 0),
    quorum_weight: Number(raw.quorum_weight ?? 0),
    total_weight: Number(raw.total_weight ?? 0),
  };
}
