// AUTO-GENERATED FILE - DO NOT EDIT BY HAND.
//
// Source: contracts/accord/src/lib.rs
// Regenerate with: python3 scripts/generate-contract-types.py
//
// CI runs the generator and fails if this file is out of date. Do not edit
// this file directly; change the contract definition instead.

export type ContractProposalStatus =
  | "Pending"
  | "Ready"
  | "Executed"
  | "Expired"
  | "Revoked";

export type ContractRole = "Proposer" | "Approver" | "Executor" | "Viewer";

export type ContractTransfer = {
  to: string;
  token: string;
  amount: bigint;
};

export type ContractAssetReference =
  | { Address: string }
  | { Classic: string };

export type ContractAssetTransfer = {
  to: string;
  asset: ContractAssetReference;
  amount: bigint;
};

export type ContractRecurringStatus = "Active" | "Paused" | "Completed" | "Cancelled";

export type ContractRecurringKind = "FixedAmountPerPeriod" | "LinearVesting";

export type ContractRecurringPayment = {
  id: number;
  proposer: string;
  recipient: string;
  token: string;
  amount: bigint;
  interval_secs: number;
  start_time: number;
  end_time: number;
  cliff_time: number;
  total_cap: bigint;
  total_disbursed: bigint;
  last_disbursed_at: number;
  periods_disbursed: number;
  status: ContractRecurringStatus;
  kind: ContractRecurringKind;
  category: ContractProposalCategory;
  description: string;
};

export type ContractCreateRecurringParams = {
  recipient: string;
  token: string;
  amount: bigint;
  interval_secs: number;
  start_time: number;
  end_time: number;
  cliff_time: number;
  total_cap: bigint;
  kind: ContractRecurringKind;
};

export type ContractProposalKind =
  | { Transfer: ContractTransfer[] }
  | { AddOwner: [string, number] }
  | { RemoveOwner: string }
  | { ChangeThreshold: number }
  | { SetSpendingLimit: [string, string, bigint] }
  | { SetSpendingLimitWindow: [string, string, bigint, number] }
  | { ChangeOwnerWeight: [string, number] }
  | { CreateRecurringPayment: ContractCreateRecurringParams }
  | { CancelRecurringPayment: number }
  | { PauseRecurringPayment: number }
  | { ResumeRecurringPayment: number }
  | { ModifyRecurringPayment: ContractModifyRecurringParams }
  | { GrantRole: [string, string] }
  | { RevokeRole: [string, string] };

export type ContractModifyRecurringParams = {
  schedule_id: number;
  new_amount: bigint | null;
  new_interval_secs: number | null;
  new_end_time: number | null;
};

export type ContractSpentTracker = {
  spent: bigint;
  epoch: number;
};

export type ContractProposalCategory =
  | "Transfer"
  | "Payroll"
  | "Grant"
  | "Ops"
  | "Other";

export type ContractProposal = {
  id: number;
  proposer: string;
  description: string;
  deadline: number;
  approvals: number;
  approval_weight: number;
  status: ContractProposalStatus;
  kind: ContractProposalKind;
  ready_at: number;
  quorum_weight: number;
  category: ContractProposalCategory;
  attachment_hash: string | null;
};

export type ContractProposalApprovalProgress = {
  approval_weight: number;
  quorum_weight: number;
  total_weight: number;
};

export type ContractOwnerWeight = {
  owner: string;
  weight: number;
};

export type ContractSpendingLimitEntry = {
  token: string;
  limit: bigint;
};

export type ContractSpendingWindowEntry = {
  token: string;
  window_secs: number;
};

export type ContractDelegation = {
  delegator: string;
  delegate: string;
  weight: number;
  expiry: number | null;
};

export type ContractDelegationInfo = {
  outgoing: ContractDelegation[];
  incoming: ContractDelegation[];
};

export type ContractProposalCreatedEvent = {
  id: number;
  proposer: string;
  threshold: number;
  category: ContractProposalCategory;
  transfers: ContractTransfer[];
  quorum_weight: number;
  total_weight_at_creation: number;
  attachment_hash: string | null;
};

export type ContractRecurringSchedule = {
  id: number;
  proposer: string;
  transfers: ContractTransfer[];
  interval_secs: number;
  last_disbursed_at: number;
  remaining_occurrences: number;
  status: ContractRecurringStatus;
  description: string;
};

export type ContractProposalApprovedEvent = {
  id: number;
  approver: string;
  approvals: number;
  threshold: number;
  weight: number;
  cumulative_weight: number;
};

export type ContractProposalRevokedEvent = {
  id: number;
  approver: string;
  approvals: number;
  weight: number;
  cumulative_weight: number;
};

export type ContractProposalExecutedEvent = {
  id: number;
  executor: string;
  transfers: ContractTransfer[];
};

export type ContractGuardianSetEvent = {
  guardian: string;
};

export type ContractFrozenEvent = {
  guardian: string;
};

export type ContractUnfrozenEvent = {
  approvers: string[];
};

export type ContractRecoveryEnteredEvent = {
  guardian: string;
};

export type ContractRecoveryExitedEvent = {
  approvers: string[];
};

export type ContractRecurringPaymentDisbursedEvent = {
  schedule_id: number;
  recipient: string;
  token: string;
  amount: bigint;
  total_disbursed: bigint;
  periods_disbursed: number;
};

export type ContractRecurringPaymentPausedEvent = {
  id: number;
  caller: string;
};

export type ContractRecurringPaymentResumedEvent = {
  id: number;
  caller: string;
};

export type ContractRecurringPaymentModifiedEvent = {
  schedule_id: number;
  previous_amount: bigint;
  new_amount: bigint;
  previous_interval: number;
  new_interval: number;
  previous_end_time: number;
  new_end_time: number;
};

export type ContractRecurringPaymentCreatedEvent = {
  id: number;
  proposer: string;
  recipient: string;
  token: string;
  amount: bigint;
  interval_secs: number;
  start_time: number;
  end_time: number;
  cliff_time: number;
  total_cap: bigint;
  kind: ContractRecurringKind;
};

export type ContractRecurringPaymentCancelledEvent = {
  id: number;
  caller: string;
};

export type ContractUpgradeExecutedEvent = {
  caller: string;
  new_wasm_hash: string;
};

export type ContractAddOwnerExecutedEvent = {
  new_owner: string;
  owner_count: number;
};

export type ContractRemoveOwnerExecutedEvent = {
  removed_owner: string;
  owner_count: number;
};

export type ContractChangeThresholdExecutedEvent = {
  previous_threshold: number;
  new_threshold: number;
};

export type ContractSetSpendingLimitExecutedEvent = {
  owner: string;
  token: string;
  previous_limit: bigint | null;
  new_limit: bigint;
};

export type ContractOwnerWeightChangedEvent = {
  owner: string;
  old_weight: number;
  new_weight: number;
  new_total_weight: number;
};

export type ContractGovernanceMigratedEvent = {
  owner_count: number;
  total_weight: number;
};

export type ContractRbacMigratedEvent = {
  owner_count: number;
  role_version: number;
};

export type ContractRoleGrantedEvent = {
  target: string;
  role: ContractRole;
  before: ContractRole[];
  after: ContractRole[];
};

export type ContractRoleRevokedEvent = {
  target: string;
  role: ContractRole;
  before: ContractRole[];
  after: ContractRole[];
};

export enum ContractError {
  AlreadyInitialized = 1,
  NotInitialized = 2,
  Unauthorized = 3,
  InvalidThreshold = 4,
  InvalidOwners = 5,
  ProposalNotFound = 6,
  ProposalNotActive = 7,
  AlreadyApproved = 8,
  NotApproved = 9,
  ThresholdNotMet = 10,
  ProposalExpired = 11,
  InvalidAmount = 12,
  InvalidDeadline = 13,
  InvalidToken = 14,
  TransferFailed = 15,
  EmptyDescription = 16,
  DescriptionTooLong = 17,
  TooManyActiveProposals = 18,
  DuplicateOwner = 19,
  ArithmeticError = 20,
  InvalidDuration = 21,
  InvalidRecipient = 22,
  TimeLockActive = 23,
  WouldBreakThreshold = 24,
  OwnerNotFound = 25,
  ContractFrozen = 26,
  NoGuardian = 27,
  RecoveryActive = 57,
  InvalidInterval = 28,
  InvalidSchedule = 29,
  InvalidCap = 30,
  SpendingLimitExceeded = 31,
  RecurringPaymentNotFound = 32,
  RecurringPaymentNotDue = 33,
  RecurringPaymentComplete = 34,
  RecurringPaymentInactive = 35,
  RecurringIntervalNotElapsed = 36,
  TooManyActiveRecurring = 37,
  ScheduleAlreadyCancelled = 38,
  ScheduleAlreadyPaused = 39,
  ScheduleNotPaused = 40,
  ScheduleTerminal = 41,
  InvalidWeightsLength = 42,
  WeightBelowMinimum = 43,
  InvalidWeight = 44,
  AlreadyMigrated = 45,
  SingleOwnerWeightCapExceeded = 46,
  TargetOwnerNoLongerExists = 47,
  WouldBreakQuorum = 48,
  CannotRemoveLastOwner = 49,
  ThresholdExceedsOwnerCount = 50,
  ScheduleNotActive = 51,
  MissingRole = 52,
  RoleAlreadyGranted = 53,
  RoleNotGranted = 54,
  InvalidRole = 55,
  DeprecatedEntrypoint = 56,
}
