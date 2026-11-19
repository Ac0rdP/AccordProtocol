/**
 * Testing harness for Accord Protocol integrators.
 * `MockAccordContract` is a deterministic, in-memory model of the proposal
 * lifecycle (create → approve → execute, recurring schedules, freeze) that
 * exposes the same method names and signatures as `AccordClient`, so code
 * written against the client can be exercised without a network.
 * `createMockRpcHandler` serves its event stream over JSON-RPC 2.0.
 *
 * Contract rules mirror `contracts/accord/src/lib.rs`: proposal ids start at
 * 1, the quorum weight is snapshotted from the threshold at creation, status
 * is derived from approval weight and deadline, and failures surface as the
 * same `AccordContractError` codes the real client raises.
 *
 * This module has no runtime dependency on `@stellar/stellar-sdk` and does not
 * import `AccordClient`, so it tree-shakes away from production bundles.
 */

import { AccordContractError, AccordValidationError, ContractError } from "./errors.js";
import type { AccordEventType, AccordParsedEvent } from "./events.js";
import type {
  CreateRecurringParams,
  Proposal,
  ProposalApprovalProgress,
  ProposalCategory,
  ProposalStatus,
  RecurringPayment,
  Transfer,
} from "./types.js";

export interface MockOwner {
  address: string;
  /** Voting weight (default: 1). */
  weight?: number;
}

export interface MockAccordContractOptions {
  /** Contract id reported on events (default: a fixed placeholder). */
  contractId?: string;
  owners: (string | MockOwner)[];
  /** Required approval weight; snapshotted onto each proposal at creation. */
  threshold: number;
  /** Seconds that must pass after a proposal becomes Ready (default: 0n). */
  timeLockDelay?: bigint;
  /** Initial ledger timestamp in Unix seconds (default: 1_700_000_000n). */
  now?: bigint;
  /** Initial ledger sequence (default: 1). */
  ledger?: number;
  /** Ledgers closed per `advanceTime` second, rounded down (default: 1 per 5s). */
  secondsPerLedger?: number;
}

/** Contract methods that can be scripted to fail with `failNext`. */
export type MockMethod =
  | "createProposal"
  | "createRecurringProposal"
  | "approve"
  | "revoke"
  | "execute";

export const MOCK_CONTRACT_ID = "CMOCKACCORDCONTRACT000000000000000000000000000000000000";

const MAX_DESCRIPTION_LEN = 300;
const MAX_PAGE_SIZE = 20;
const MIN_INTERVAL_SECS = 60n;
const MAX_INTERVAL_SECS = 365n * 24n * 60n * 60n;

interface StoredProposal extends Proposal {
  /** Raw status before deadline derivation; only terminal values are sticky. */
  stored: ProposalStatus;
  recurring?: CreateRecurringParams;
  approvalWeights: Map<string, number>;
}

function fail(code: ContractError): never {
  throw new AccordContractError(code);
}

/**
 * Deterministic in-memory Accord contract. Every write returns a stable,
 * counter-based transaction hash and appends to an ordered event log.
 */
export class MockAccordContract {
  public readonly contractId: string;
  private readonly owners = new Map<string, number>();
  private readonly threshold: number;
  private readonly timeLockDelay: bigint;
  private readonly secondsPerLedger: number;
  private readonly proposals: StoredProposal[] = [];
  private readonly schedules: RecurringPayment[] = [];
  private readonly log: AccordParsedEvent[] = [];
  private readonly failures = new Map<MockMethod, Error[]>();
  private nowSecs: bigint;
  private ledgerSeq: number;
  private txCount = 0;
  private frozen = false;

  constructor(options: MockAccordContractOptions) {
    if (!Array.isArray(options.owners) || options.owners.length === 0) {
      throw new AccordValidationError("owners", "At least one owner is required.");
    }
    for (const entry of options.owners) {
      const owner = typeof entry === "string" ? { address: entry } : entry;
      const weight = owner.weight ?? 1;
      if (!owner.address) {
        throw new AccordValidationError("owners", "Owner address cannot be empty.");
      }
      if (!Number.isInteger(weight) || weight < 1) {
        throw new AccordValidationError("owners", `Weight for '${owner.address}' must be an integer >= 1.`);
      }
      if (this.owners.has(owner.address)) {
        throw new AccordValidationError("owners", `Duplicate owner '${owner.address}'.`);
      }
      this.owners.set(owner.address, weight);
    }
    if (!Number.isInteger(options.threshold) || options.threshold < 1 || options.threshold > this.totalWeight()) {
      throw new AccordValidationError("threshold", "Threshold must be an integer between 1 and the total owner weight.");
    }

    this.contractId = options.contractId ?? MOCK_CONTRACT_ID;
    this.threshold = options.threshold;
    this.timeLockDelay = options.timeLockDelay ?? 0n;
    this.nowSecs = options.now ?? 1_700_000_000n;
    this.ledgerSeq = options.ledger ?? 1;
    this.secondsPerLedger = options.secondsPerLedger ?? 5;
  }

  // ─── Test controls ─────────────────────────────────────────────────────────

  /** Current ledger timestamp (Unix seconds). */
  get now(): bigint {
    return this.nowSecs;
  }

  /** Current ledger sequence. */
  get ledger(): number {
    return this.ledgerSeq;
  }

  /** Moves the ledger clock forward and closes the corresponding ledgers. */
  advanceTime(seconds: bigint | number): this {
    const delta = BigInt(seconds);
    if (delta < 0n) throw new AccordValidationError("seconds", "Time cannot move backwards.");
    this.nowSecs += delta;
    this.ledgerSeq += Math.floor(Number(delta) / this.secondsPerLedger);
    return this;
  }

  setFrozen(frozen: boolean): this {
    this.frozen = frozen;
    return this;
  }

  /** Makes the next call to `method` reject with `error` instead of running. */
  failNext(method: MockMethod, error: Error = new AccordContractError(ContractError.Unauthorized)): this {
    const queue = this.failures.get(method) ?? [];
    queue.push(error);
    this.failures.set(method, queue);
    return this;
  }

  /** Every event emitted so far, oldest first. */
  get events(): readonly AccordParsedEvent[] {
    return this.log;
  }

  /**
   * Returns events after `cursor` (an event id). Pass this as the fetcher to
   * `subscribeEvents` to drive subscriptions from the mock.
   */
  async fetchEvents(cursor: string | null = null, limit = 100): Promise<AccordParsedEvent[]> {
    const start = cursor === null ? 0 : this.log.findIndex((e) => e.id === cursor) + 1;
    return this.log.slice(start, start + limit);
  }

  // ─── Reads (AccordClient-compatible) ───────────────────────────────────────

  async getProposal(proposalId: bigint | number): Promise<Proposal> {
    return this.snapshot(this.find(proposalId));
  }

  async getProposalsPaged(offset: bigint | number, limit = 20): Promise<Proposal[]> {
    const start = Number(offset);
    const count = Math.min(limit, MAX_PAGE_SIZE);
    return this.proposals.slice(start, start + count).map((p) => this.snapshot(p));
  }

  async getOwners(): Promise<string[]> {
    return [...this.owners.keys()];
  }

  async getThreshold(): Promise<number> {
    return this.threshold;
  }

  async getRequiredQuorumWeight(): Promise<number> {
    return this.threshold;
  }

  async getTotalWeight(): Promise<number> {
    return this.totalWeight();
  }

  async getOwnerWeight(owner: string): Promise<number> {
    return this.owners.get(owner) ?? fail(ContractError.OwnerNotFound);
  }

  async isOwner(address: string): Promise<boolean> {
    return this.owners.has(address);
  }

  async hasApproved(proposalId: bigint | number, owner: string): Promise<boolean> {
    return (this.find(proposalId).approvalWeights.get(owner) ?? 0) > 0;
  }

  async getProposalApprovalProgress(proposalId: bigint | number): Promise<ProposalApprovalProgress> {
    const p = this.find(proposalId);
    return { approval_weight: p.approval_weight, quorum_weight: p.quorum_weight, total_weight: this.totalWeight() };
  }

  async getApprovers(proposalId: bigint | number): Promise<string[]> {
    return [...this.find(proposalId).approvalWeights.keys()];
  }

  async getTotalProposals(): Promise<bigint> {
    return BigInt(this.proposals.length);
  }

  async getTimeLockDelay(): Promise<bigint> {
    return this.timeLockDelay;
  }

  async isFrozen(): Promise<boolean> {
    return this.frozen;
  }

  async getRecurringPayment(scheduleId: bigint | number): Promise<RecurringPayment> {
    const schedule = this.schedules.find((s) => s.id === BigInt(scheduleId));
    if (!schedule) fail(ContractError.RecurringPaymentNotFound);
    return { ...schedule };
  }

  async getActiveRecurringCount(): Promise<number> {
    return this.schedules.filter((s) => s.status === "Active").length;
  }

  // ─── Writes (AccordClient-compatible) ──────────────────────────────────────

  async createProposal(
    proposer: string,
    transfers: Transfer[],
    description: string,
    deadline: bigint,
    category: ProposalCategory = "Transfer"
  ): Promise<string> {
    this.consumeFailure("createProposal");
    if (transfers.length === 0 || transfers.some((t) => t.amount <= 0n)) fail(ContractError.InvalidAmount);
    return this.propose(proposer, { Transfer: transfers.map((t) => ({ ...t })) }, description, deadline, category);
  }

  async createRecurringProposal(
    proposer: string,
    params: CreateRecurringParams,
    description: string,
    deadline: bigint,
    category: ProposalCategory = "Transfer"
  ): Promise<string> {
    this.consumeFailure("createRecurringProposal");
    if (params.amount <= 0n) fail(ContractError.InvalidAmount);
    if (params.interval_secs < MIN_INTERVAL_SECS || params.interval_secs > MAX_INTERVAL_SECS) {
      fail(ContractError.InvalidInterval);
    }
    if (params.total_cap !== 0n && params.total_cap < params.amount) fail(ContractError.InvalidCap);
    return this.propose(proposer, { CreateRecurringPayment: { ...params } }, description, deadline, category, params);
  }

  async approve(approver: string, proposalId: bigint | number): Promise<string> {
    this.consumeFailure("approve");
    const weight = this.requireOwner(approver);
    const p = this.requireActive(proposalId);
    if (p.approvalWeights.has(approver)) fail(ContractError.AlreadyApproved);

    p.approvalWeights.set(approver, weight);
    p.approvals += weight;
    p.approval_weight += weight;
    if (p.ready_at === 0n && p.approvals >= p.quorum_weight) p.ready_at = this.nowSecs;

    return this.emit("proposal_approved", {
      id: p.id,
      approver,
      approvals: p.approvals,
      threshold: p.quorum_weight,
      weight,
      cumulative_weight: p.approvals,
    });
  }

  async revoke(approver: string, proposalId: bigint | number): Promise<string> {
    this.consumeFailure("revoke");
    this.requireOwner(approver);
    const p = this.requireActive(proposalId);
    const weight = p.approvalWeights.get(approver);
    if (weight === undefined) fail(ContractError.NotApproved);

    p.approvalWeights.delete(approver);
    p.approvals -= weight;
    p.approval_weight -= weight;

    return this.emit("proposal_revoked", {
      id: p.id,
      approver,
      approvals: p.approvals,
      weight,
      cumulative_weight: p.approvals,
    });
  }

  async execute(executor: string, proposalId: bigint | number): Promise<string> {
    this.consumeFailure("execute");
    this.requireOwner(executor);
    if (this.frozen) fail(ContractError.ContractFrozen);
    const p = this.find(proposalId);
    const status = this.status(p);
    if (status === "Expired") fail(ContractError.ProposalExpired);
    if (status !== "Ready") {
      fail(p.approvals < p.quorum_weight ? ContractError.ThresholdNotMet : ContractError.ProposalNotActive);
    }
    if (this.timeLockDelay > 0n && this.nowSecs < p.ready_at + this.timeLockDelay) {
      fail(ContractError.TimeLockActive);
    }

    p.stored = "Executed";
    if (p.recurring) this.startSchedule(p);
    return this.emit("proposal_executed", { id: p.id, executor });
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private totalWeight(): number {
    let total = 0;
    for (const weight of this.owners.values()) total += weight;
    return total;
  }

  private consumeFailure(method: MockMethod): void {
    const error = this.failures.get(method)?.shift();
    if (error) throw error;
  }

  private requireOwner(address: string): number {
    return this.owners.get(address) ?? fail(ContractError.Unauthorized);
  }

  private find(proposalId: bigint | number): StoredProposal {
    const id = BigInt(proposalId);
    const p = id >= 1n ? this.proposals[Number(id - 1n)] : undefined;
    return p ?? fail(ContractError.ProposalNotFound);
  }

  private requireActive(proposalId: bigint | number): StoredProposal {
    const p = this.find(proposalId);
    const status = this.status(p);
    if (status !== "Pending" && status !== "Ready") fail(ContractError.ProposalNotActive);
    return p;
  }

  /** Mirrors `derive_status`: terminal states stick, otherwise deadline then weight decide. */
  private status(p: StoredProposal): ProposalStatus {
    if (p.stored === "Executed" || p.stored === "Revoked") return p.stored;
    if (this.nowSecs > p.deadline) return "Expired";
    return p.approvals >= p.quorum_weight ? "Ready" : "Pending";
  }

  private snapshot(p: StoredProposal): Proposal {
    const { stored: _stored, recurring: _recurring, approvalWeights: _weights, ...proposal } = p;
    return { ...proposal, status: this.status(p) };
  }

  private propose(
    proposer: string,
    kind: Proposal["kind"],
    description: string,
    deadline: bigint,
    category: ProposalCategory,
    recurring?: CreateRecurringParams
  ): string {
    this.requireOwner(proposer);
    if (this.frozen) fail(ContractError.ContractFrozen);
    if (description.trim().length === 0) fail(ContractError.EmptyDescription);
    if (description.length > MAX_DESCRIPTION_LEN) fail(ContractError.DescriptionTooLong);
    if (deadline <= this.nowSecs) fail(ContractError.InvalidDeadline);

    const id = BigInt(this.proposals.length + 1);
    this.proposals.push({
      id,
      proposer,
      description,
      deadline,
      approvals: 0,
      approval_weight: 0,
      status: "Pending",
      kind,
      ready_at: 0n,
      quorum_weight: this.threshold,
      category,
      attachment_hash: null,
      stored: "Pending",
      recurring,
      approvalWeights: new Map(),
    });

    return this.emit("proposal_created", {
      id,
      proposer,
      threshold: this.threshold,
      category,
      transfers: "Transfer" in kind ? kind.Transfer : [],
      quorum_weight: this.threshold,
      total_weight_at_creation: this.totalWeight(),
      attachment_hash: null,
    });
  }

  private startSchedule(p: StoredProposal): void {
    const params = p.recurring!;
    this.schedules.push({
      id: BigInt(this.schedules.length + 1),
      proposer: p.proposer,
      recipient: params.recipient,
      token: params.token,
      amount: params.amount,
      interval_secs: params.interval_secs,
      start_time: params.start_time,
      end_time: params.end_time,
      cliff_time: params.cliff_time,
      total_cap: params.total_cap,
      total_disbursed: 0n,
      last_disbursed_at: 0n,
      periods_disbursed: 0,
      status: "Active",
      kind: params.kind,
      category: p.category,
      description: p.description,
    });
  }

  /** Records a transaction: one ledger closes, one event is appended. */
  private emit(type: AccordEventType, data: Record<string, unknown>): string {
    this.txCount += 1;
    this.ledgerSeq += 1;
    const txHash = this.txCount.toString(16).padStart(64, "0");
    this.log.push({
      id: `${txHash}:${this.ledgerSeq}:0`,
      type,
      contractId: this.contractId,
      ledger: this.ledgerSeq,
      txHash,
      eventIndex: 0,
      timestamp: new Date(Number(this.nowSecs) * 1000).toISOString(),
      data: { version: 2, ...data },
    });
    return txHash;
  }
}

// ─── Mock JSON-RPC server ────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string } };

/** JSON-RPC 2.0 "Method not found". */
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
/** JSON-RPC 2.0 "Invalid params". */
export const JSON_RPC_INVALID_PARAMS = -32602;
/** JSON-RPC 2.0 "Invalid Request". */
export const JSON_RPC_INVALID_REQUEST = -32600;

/** Stringifies bigints so results survive `JSON.stringify` on the wire. */
function toWire(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

/**
 * Returns a JSON-RPC 2.0 handler backed by `contract`. Supports the
 * Soroban-RPC-shaped methods integrators poll — `getHealth`,
 * `getLatestLedger` and `getEvents` (`{ cursor?, limit? }`) — with decoded
 * Accord events in place of XDR. Mount it behind any HTTP server or call it
 * directly from tests.
 */
export function createMockRpcHandler(
  contract: MockAccordContract
): (request: JsonRpcRequest) => Promise<JsonRpcResponse> {
  return async (request) => {
    const id = request?.id ?? null;
    if (request?.jsonrpc !== "2.0" || typeof request.method !== "string") {
      return { jsonrpc: "2.0", id, error: { code: JSON_RPC_INVALID_REQUEST, message: "Invalid Request" } };
    }

    switch (request.method) {
      case "getHealth":
        return { jsonrpc: "2.0", id, result: { status: "healthy", latestLedger: contract.ledger } };
      case "getLatestLedger":
        return { jsonrpc: "2.0", id, result: { sequence: contract.ledger, protocolVersion: 22 } };
      case "getEvents": {
        const cursor = request.params?.cursor ?? null;
        const limit = request.params?.limit ?? 100;
        if ((cursor !== null && typeof cursor !== "string") || !Number.isInteger(limit) || (limit as number) < 1) {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: JSON_RPC_INVALID_PARAMS, message: "Expected { cursor?: string, limit?: positive integer }." },
          };
        }
        const events = await contract.fetchEvents(cursor as string | null, limit as number);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            events: toWire(events),
            cursor: events.length ? events[events.length - 1].id : cursor,
            latestLedger: contract.ledger,
          },
        };
      }
      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: JSON_RPC_METHOD_NOT_FOUND, message: `Method '${request.method}' not found` },
        };
    }
  };
}
