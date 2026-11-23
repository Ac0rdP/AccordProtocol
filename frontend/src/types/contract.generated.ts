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
  | "Revoked"
  | "Cancelled";

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

export type ContractRecurringKind =
  | "FixedAmountPerPeriod"
  | "LinearVesting"
  | "ContinuousStream";

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

export type ContractEscrowReleaseMode =
  | { OwnerQuorumUntil: number }
  | { Deadline: number };

export type ContractEscrowParams = {
  recipient: string;
  token: string;
  amount: bigint;
  release_mode: ContractEscrowReleaseMode;
};

export type ContractProposalKind =
  | { Transfer: ContractTransfer[] }
  | { AddOwner: [string, number] }
  | { RemoveOwner: string }
  | { ChangeThreshold: number }
  | { SetSpendingLimit: [string, string, bigint] }
  | { SetSpendingLimitWindow: [string, string, bigint, number] }
  | { SetTreasurySpendingLimit: [string, bigint, number] }
  | { ChangeOwnerWeight: [string, number] }
  | { CreateRecurringPayment: ContractCreateRecurringParams }
  | { CancelRecurringPayment: number }
  | { PauseRecurringPayment: number }
  | { ResumeRecurringPayment: number }
  | { ModifyRecurringPayment: ContractModifyRecurringParams }
  | { GrantRole: [string, string] }
  | { RevokeRole: [string, string] }
  | { SetAssetRegistryEnabled: boolean }
  | { AddApprovedToken: string }
  | { RemoveApprovedToken: string }
  | { TransferGuardian: string }
  | { RotateOwner: [string, string] }
  | { CreateEscrow: ContractEscrowParams };

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

export type ContractProposalSimulation = {
  category: ContractProposalCategory;
  quorum_weight: number;
  proposer: string;
  required_role: ContractRole;
  proposer_auth_required: boolean;
  transfer_count: number;
  distinct_token_count: number;
  owner_spending_limit_checks: number;
  minimum_persistent_writes: number;
  minimum_instance_writes: number;
  emitted_events: number;
};

export type ContractProposalApprovalProgress = {
  approval_weight: number;
  quorum_weight: number;
  total_weight: number;
  abstention_count: number;
  abstention_weight: number;
  participation_weight: number;
  soft_approval_count: number;
  soft_approval_weight: number;
};

export type ContractOwnerWeight = {
  owner: string;
  weight: number;
};

export type ContractSpendingLimitEntry = {
  token: string;
  limit: bigint;
};

export type ContractEscrowRecord = {
  id: number;
  recipient: string;
  token: string;
  amount: bigint;
  release_mode: ContractEscrowReleaseMode;
};

export type ContractProposalKindTag =
  | "Transfer"
  | "Recurring"
  | "Escrow"
  | "Ownership"
  | "Governance";

export type ContractFreezeScope =
  | { Asset: string }
  | { Kind: ContractProposalKindTag };

export type ContractScopedFreezeChangedEvent = {
  scope: ContractFreezeScope;
  frozen: boolean;
  guardian: string;
  version: number;
};

export type ContractGuardianQuorumConfig = {
  guardians: string[];
  threshold: number;
};

export type ContractSocialRecoveryRequest = {
  id: number;
  new_owner: string;
  replace_owner: string | null;
  approvals: string[];
  proposed_at: number;
  execute_after: number;
  executed: boolean;
};

export type ContractGuardianQuorumConfiguredEvent = {
  guardians: string[];
  threshold: number;
  version: number;
};

export type ContractSocialRecoveryProposedEvent = {
  id: number;
  new_owner: string;
  replace_owner: string | null;
  proposed_at: number;
  version: number;
};

export type ContractSocialRecoveryApprovedEvent = {
  id: number;
  guardian: string;
  approvals: number;
  threshold: number;
  execute_after: number;
  version: number;
};

export type ContractSocialRecoveryExecutedEvent = {
  id: number;
  new_owner: string;
  replace_owner: string | null;
  executed_at: number;
  version: number;
};

export type ContractOwnerRotatedEvent = {
  old_owner: string;
  new_owner: string;
  weight: number;
  version: number;
};

export type ContractStorageMigratedEvent = {
  from_version: number;
  to_version: number;
  version: number;
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
  version: number;
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
  version: number;
};

export type ContractProposalRevokedEvent = {
  id: number;
  approver: string;
  approvals: number;
  weight: number;
  cumulative_weight: number;
  version: number;
};

export type ContractProposalAbstainedEvent = {
  id: number;
  abstainer: string;
  abstention_count: number;
  weight: number;
  cumulative_abstention_weight: number;
  participation_weight: number;
  version: number;
};

export type ContractProposalAbstentionRevokedEvent = {
  id: number;
  abstainer: string;
  abstention_count: number;
  weight: number;
  cumulative_abstention_weight: number;
  participation_weight: number;
  version: number;
};

export type ContractProposalSoftApprovedEvent = {
  id: number;
  supporter: string;
  soft_approval_count: number;
  weight: number;
  cumulative_soft_weight: number;
  participation_weight: number;
  version: number;
};

export type ContractProposalSoftApprovalRevokedEvent = {
  id: number;
  supporter: string;
  soft_approval_count: number;
  weight: number;
  cumulative_soft_weight: number;
  participation_weight: number;
  version: number;
};

export type ContractProposalExecutedEvent = {
  id: number;
  executor: string;
  version: number;
};

export type ContractProposalCancelledEvent = {
  id: number;
  proposer: string;
};

export type ContractExpiredProposalsSweptEvent = {
  swept: number;
};

export type ContractGuardianSetEvent = {
  guardian: string;
  version: number;
};

export type ContractApprovedTokenChangedEvent = {
  token: string;
  approved: boolean;
};

export type ContractAssetRegistryEnabledEvent = {
  enabled: boolean;
};

export type ContractEscrowCreatedEvent = {
  id: number;
  recipient: string;
  token: string;
  amount: bigint;
  release_mode: ContractEscrowReleaseMode;
};

export type ContractEscrowReleasedEvent = {
  id: number;
  recipient: string;
  token: string;
  amount: bigint;
};

export type ContractEscrowRefundedEvent = {
  id: number;
  token: string;
  amount: bigint;
};

export type ContractFrozenEvent = {
  guardian: string;
  version: number;
};

export type ContractUnfrozenEvent = {
  approvers: string[];
  version: number;
};

export type ContractRecoveryEnteredEvent = {
  guardian: string;
  version: number;
};

export type ContractRecoveryExitedEvent = {
  approvers: string[];
  version: number;
};

export type ContractRecurringPaymentDisbursedEvent = {
  schedule_id: number;
  recipient: string;
  token: string;
  amount: bigint;
  total_disbursed: bigint;
  periods_disbursed: number;
  version: number;
};

export type ContractRecurringStreamClaimedEvent = {
  schedule_id: number;
  recipient: string;
  token: string;
  amount: bigint;
  total_disbursed: bigint;
};

export type ContractRecurringPaymentPausedEvent = {
  id: number;
  caller: string;
  version: number;
};

export type ContractRecurringPaymentResumedEvent = {
  id: number;
  caller: string;
  version: number;
};

export type ContractRecurringPaymentModifiedEvent = {
  schedule_id: number;
  previous_amount: bigint;
  new_amount: bigint;
  previous_interval: number;
  new_interval: number;
  previous_end_time: number;
  new_end_time: number;
  version: number;
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
  version: number;
};

export type ContractRecurringPaymentCancelledEvent = {
  id: number;
  caller: string;
  version: number;
};

export type ContractUpgradeExecutedEvent = {
  caller: string;
  new_wasm_hash: string;
  version: number;
};

export type ContractAddOwnerExecutedEvent = {
  new_owner: string;
  owner_count: number;
  version: number;
};

export type ContractRemoveOwnerExecutedEvent = {
  removed_owner: string;
  owner_count: number;
  version: number;
};

export type ContractChangeThresholdExecutedEvent = {
  previous_threshold: number;
  new_threshold: number;
  version: number;
};

export type ContractSetSpendingLimitExecutedEvent = {
  owner: string;
  token: string;
  previous_limit: bigint | null;
  new_limit: bigint;
  version: number;
};

export type ContractOwnerWeightChangedEvent = {
  owner: string;
  old_weight: number;
  new_weight: number;
  new_total_weight: number;
  version: number;
};

export type ContractGovernanceMigratedEvent = {
  owner_count: number;
  total_weight: number;
  version: number;
};

export type ContractRbacMigratedEvent = {
  owner_count: number;
  role_version: number;
  version: number;
};

export type ContractRoleGrantedEvent = {
  target: string;
  role: ContractRole;
  before: ContractRole[];
  after: ContractRole[];
  version: number;
};

export type ContractRoleRevokedEvent = {
  target: string;
  role: ContractRole;
  before: ContractRole[];
  after: ContractRole[];
  version: number;
};

export type ContractAssetTreasuryAccounting = {
  token: string;
  total_spent: bigint;
  window_spent: bigint;
  spend_limit: bigint | null;
  window_secs: number;
  epoch: number;
  available_limit: bigint | null;
};

export type ContractProposalDependenciesSetEvent = {
  id: number;
  dependencies: number[];
  version: number;
};

export type ContractTreasurySpendingLimitExecutedEvent = {
  token: string;
  previous_limit: bigint | null;
  new_limit: bigint;
  window_secs: number;
  version: number;
};

export type ContractTreasurySpendTrackedEvent = {
  token: string;
  amount: bigint;
  total_spent_window: bigint;
  total_spent_lifetime: bigint;
  version: number;
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
  RecoveryActive = 57,
  AssetNotApproved = 61,
  AssetRegistryState = 62,
  EscrowNotFound = 63,
  EscrowConditionNotMet = 64,
  EscrowFundsUnavailable = 65,
  DependencyNotExecuted = 66,
  DependencyCancelled = 67,
  DependencyExpired = 68,
  InvalidDependency = 69,
  DuplicateDependency = 70,
  TooManyDependencies = 71,
  TreasurySpendingLimitExceeded = 72,
  InvalidSpendingLimit = 73,
  DependencyNotFound = 74,
  AlreadyAbstained = 75,
  NotAbstained = 76,
  AlreadySoftApproved = 77,
  NotSoftApproved = 78,
  UnsupportedSchemaVersion = 79,
  SkippedSchemaVersion = 80,
  SchemaVersionMismatch = 81,
  LegacyMigrationRequired = 82,
  OwnerRotationDelayActive = 83,
  GuardianQuorumNotConfigured = 84,
  InvalidGuardianQuorum = 85,
  NotGuardian = 86,
  RecoveryRequestNotFound = 87,
  RecoveryRequestNotReady = 88,
  RecoveryDelayActive = 89,
}
