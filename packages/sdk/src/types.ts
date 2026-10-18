/**
 * TypeScript Type Definitions for Accord Protocol Smart Contract
 * Grounded in contracts/accord/src/lib.rs
 */

export type ProposalStatus = "Pending" | "Ready" | "Executed" | "Expired" | "Revoked";

export type Role = "Proposer" | "Approver" | "Executor" | "Viewer";

export type ProposalCategory = "Transfer" | "Payroll" | "Grant" | "Ops" | "Other";

export type RecurringStatus = "Active" | "Paused" | "Completed" | "Cancelled";

export type RecurringKind = "FixedAmountPerPeriod" | "LinearVesting";

export interface Transfer {
  to: string;
  token: string;
  amount: bigint;
}

export type AssetReference =
  | { Address: string }
  | { Classic: string };

export interface AssetTransfer {
  to: string;
  asset: AssetReference;
  amount: bigint;
}

export interface OwnerWeight {
  owner: string;
  weight: number;
}

export interface SpendingLimitEntry {
  token: string;
  limit: bigint;
}

export interface SpendingWindowEntry {
  token: string;
  window_secs: bigint;
}

export interface SpentTracker {
  spent: bigint;
  epoch: bigint;
}

export interface Delegation {
  delegator: string;
  delegate: string;
  weight: number;
  expiry: bigint | null;
}

export interface DelegationInfo {
  outgoing: Delegation[];
  incoming: Delegation[];
}

export interface CreateRecurringParams {
  recipient: string;
  token: string;
  amount: bigint;
  interval_secs: bigint;
  start_time: bigint;
  end_time: bigint;
  cliff_time: bigint;
  total_cap: bigint;
  kind: RecurringKind;
}

export interface ModifyRecurringParams {
  schedule_id: bigint;
  new_amount?: bigint | null;
  new_interval_secs?: bigint | null;
  new_end_time?: bigint | null;
}

export interface RecurringPayment {
  id: bigint;
  proposer: string;
  recipient: string;
  token: string;
  amount: bigint;
  interval_secs: bigint;
  start_time: bigint;
  end_time: bigint;
  cliff_time: bigint;
  total_cap: bigint;
  total_disbursed: bigint;
  last_disbursed_at: bigint;
  periods_disbursed: number;
  status: RecurringStatus;
  kind: RecurringKind;
  category: ProposalCategory;
  description: string;
}

export type ProposalKind =
  | { Transfer: Transfer[] }
  | { AddOwner: [string, number] }
  | { RemoveOwner: string }
  | { ChangeThreshold: number }
  | { SetSpendingLimit: [string, string, bigint] }
  | { SetSpendingLimitWindow: [string, string, bigint, bigint] }
  | { ChangeOwnerWeight: [string, number] }
  | { CreateRecurringPayment: CreateRecurringParams }
  | { CancelRecurringPayment: bigint }
  | { PauseRecurringPayment: bigint }
  | { ResumeRecurringPayment: bigint }
  | { ModifyRecurringPayment: ModifyRecurringParams }
  | { GrantRole: [string, string] }
  | { RevokeRole: [string, string] };

export interface Proposal {
  id: bigint;
  proposer: string;
  description: string;
  deadline: bigint;
  approvals: number;
  approval_weight: number;
  status: ProposalStatus;
  kind: ProposalKind;
  ready_at: bigint;
  quorum_weight: number;
  category: ProposalCategory;
  attachment_hash: string | null;
}

export interface ProposalApprovalProgress {
  approval_weight: number;
  quorum_weight: number;
  total_weight: number;
}

// ─── Contract Events ─────────────────────────────────────────────────────────

export interface BaseEvent {
  version: number;
}

export interface ProposalCreatedEvent extends BaseEvent {
  id: bigint;
  proposer: string;
  threshold: number;
  category: ProposalCategory;
  transfers: Transfer[];
  quorum_weight: number;
  total_weight_at_creation: number;
  attachment_hash: string | null;
}

export interface ProposalApprovedEvent extends BaseEvent {
  id: bigint;
  approver: string;
  approvals: number;
  threshold: number;
  weight: number;
  cumulative_weight: number;
}

export interface ProposalRevokedEvent extends BaseEvent {
  id: bigint;
  approver: string;
  approvals: number;
  weight: number;
  cumulative_weight: number;
}

export interface ProposalExecutedEvent extends BaseEvent {
  id: bigint;
  executor: string;
  transfers: Transfer[];
}

export interface GuardianSetEvent extends BaseEvent {
  guardian: string;
}

export interface FrozenEvent extends BaseEvent {
  guardian: string;
}

export interface UnfrozenEvent extends BaseEvent {
  approvers: string[];
}

export interface RecoveryEnteredEvent extends BaseEvent {
  guardian: string;
}

export interface RecoveryExitedEvent extends BaseEvent {
  approvers: string[];
}

export interface RecurringPaymentDisbursedEvent extends BaseEvent {
  schedule_id: bigint;
  recipient: string;
  token: string;
  amount: bigint;
  total_disbursed: bigint;
  periods_disbursed: number;
}

export interface RecurringPaymentPausedEvent extends BaseEvent {
  id: bigint;
  caller: string;
}

export interface RecurringPaymentResumedEvent extends BaseEvent {
  id: bigint;
  caller: string;
}

export interface RecurringPaymentModifiedEvent extends BaseEvent {
  schedule_id: bigint;
  previous_amount: bigint;
  new_amount: bigint;
  previous_interval: bigint;
  new_interval: bigint;
  previous_end_time: bigint;
  new_end_time: bigint;
}

export interface RecurringPaymentCreatedEvent extends BaseEvent {
  id: bigint;
  proposer: string;
  recipient: string;
  token: string;
  amount: bigint;
  interval_secs: bigint;
  start_time: bigint;
  end_time: bigint;
  cliff_time: bigint;
  total_cap: bigint;
  kind: RecurringKind;
}

export interface RecurringPaymentCancelledEvent extends BaseEvent {
  id: bigint;
  caller: string;
}

export interface UpgradeExecutedEvent extends BaseEvent {
  caller: string;
  new_wasm_hash: string;
}

export interface AddOwnerExecutedEvent extends BaseEvent {
  new_owner: string;
  owner_count: number;
}

export interface RemoveOwnerExecutedEvent extends BaseEvent {
  removed_owner: string;
  owner_count: number;
}

export interface ChangeThresholdExecutedEvent extends BaseEvent {
  previous_threshold: number;
  new_threshold: number;
}

export interface SetSpendingLimitExecutedEvent extends BaseEvent {
  owner: string;
  token: string;
  previous_limit: bigint | null;
  new_limit: bigint;
}

export interface OwnerWeightChangedEvent extends BaseEvent {
  owner: string;
  old_weight: number;
  new_weight: number;
  new_total_weight: number;
}

export interface GovernanceMigratedEvent extends BaseEvent {
  owner_count: number;
  total_weight: number;
}

export interface RbacMigratedEvent extends BaseEvent {
  owner_count: number;
  role_version: number;
}

export interface RoleGrantedEvent extends BaseEvent {
  target: string;
  role: Role;
  before: Role[];
  after: Role[];
}

export interface RoleRevokedEvent extends BaseEvent {
  target: string;
  role: Role;
  before: Role[];
  after: Role[];
}
