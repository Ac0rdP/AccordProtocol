/**
 * Typed Error Definitions for Accord Protocol Smart Contract
 * Maps directly to ContractError enum in contracts/accord/src/lib.rs
 */

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
}

export const ERROR_MESSAGES: Record<ContractError, string> = {
  [ContractError.AlreadyInitialized]: "Contract has already been initialized.",
  [ContractError.NotInitialized]: "Contract has not been initialized.",
  [ContractError.Unauthorized]: "Caller is unauthorized or not a registered owner/role holder.",
  [ContractError.InvalidThreshold]: "Threshold must be at least 1 and not exceed total voting weight.",
  [ContractError.InvalidOwners]: "Invalid owners configuration: must contain between 1 and 20 distinct owners.",
  [ContractError.ProposalNotFound]: "Proposal not found.",
  [ContractError.ProposalNotActive]: "Proposal is not in an active state (must be Pending or Ready).",
  [ContractError.AlreadyApproved]: "Caller has already approved this proposal.",
  [ContractError.NotApproved]: "Caller has not approved this proposal.",
  [ContractError.ThresholdNotMet]: "Approval threshold weight has not been reached.",
  [ContractError.ProposalExpired]: "Proposal deadline has passed.",
  [ContractError.InvalidAmount]: "Invalid amount: must be positive and within valid transfer constraints.",
  [ContractError.InvalidDeadline]: "Invalid deadline: must be strictly in the future.",
  [ContractError.InvalidToken]: "Invalid token address or unsupported classic asset symbol.",
  [ContractError.TransferFailed]: "Token transfer failed or returned a non-unit result.",
  [ContractError.EmptyDescription]: "Proposal description cannot be empty.",
  [ContractError.DescriptionTooLong]: "Proposal description exceeds 300 characters.",
  [ContractError.TooManyActiveProposals]: "Maximum active proposal cap (50) reached.",
  [ContractError.DuplicateOwner]: "Duplicate owner address provided.",
  [ContractError.ArithmeticError]: "Arithmetic overflow or underflow occurred.",
  [ContractError.InvalidDuration]: "Invalid duration parameter.",
  [ContractError.InvalidRecipient]: "Invalid recipient address.",
  [ContractError.TimeLockActive]: "Proposal time-lock delay has not elapsed.",
  [ContractError.WouldBreakThreshold]: "Operation would cause remaining owner count or weight to fall below threshold.",
  [ContractError.OwnerNotFound]: "Owner address not found in current owner registry.",
  [ContractError.ContractFrozen]: "Contract is currently frozen by the guardian.",
  [ContractError.NoGuardian]: "No guardian address is configured.",
  [ContractError.InvalidInterval]: "Recurring interval must be between 60 seconds and 365 days.",
  [ContractError.InvalidSchedule]: "Invalid recurring schedule parameters.",
  [ContractError.InvalidCap]: "Total cap must be non-negative and greater than or equal to interval amount.",
  [ContractError.SpendingLimitExceeded]: "Transfer amount exceeds the owner's configured spending limit.",
  [ContractError.RecurringPaymentNotFound]: "Recurring payment schedule not found.",
  [ContractError.RecurringPaymentNotDue]: "Disbursement is not yet due (cliff or start time not reached).",
  [ContractError.RecurringPaymentComplete]: "Recurring payment schedule has completed all occurrences or reached its cap.",
  [ContractError.RecurringPaymentInactive]: "Recurring payment schedule is not active.",
  [ContractError.RecurringIntervalNotElapsed]: "Minimum interval has not elapsed since the last disbursement.",
  [ContractError.TooManyActiveRecurring]: "Maximum concurrent active recurring schedules (20) reached.",
  [ContractError.ScheduleAlreadyCancelled]: "Recurring payment schedule is already cancelled.",
  [ContractError.ScheduleAlreadyPaused]: "Recurring payment schedule is already paused.",
  [ContractError.ScheduleNotPaused]: "Recurring payment schedule is not paused.",
  [ContractError.ScheduleTerminal]: "Schedule is terminal (completed or cancelled) and cannot be modified.",
  [ContractError.InvalidWeightsLength]: "Weights vector length does not match owner count.",
  [ContractError.WeightBelowMinimum]: "Owner voting weight is below the minimum allowed (1).",
  [ContractError.InvalidWeight]: "Invalid weight parameter.",
  [ContractError.AlreadyMigrated]: "Contract has already been migrated to this schema/governance mode.",
  [ContractError.SingleOwnerWeightCapExceeded]: "Owner voting weight exceeds the 50% single-owner cap.",
  [ContractError.TargetOwnerNoLongerExists]: "Target owner address no longer exists.",
  [ContractError.WouldBreakQuorum]: "Operation would break the required governance quorum.",
  [ContractError.CannotRemoveLastOwner]: "Cannot remove the last remaining multisig owner.",
  [ContractError.ThresholdExceedsOwnerCount]: "Threshold cannot exceed total owner count.",
  [ContractError.ScheduleNotActive]: "Recurring payment schedule is not in Active status.",
  [ContractError.MissingRole]: "Caller does not hold the required operational role.",
  [ContractError.RoleAlreadyGranted]: "Address already holds the specified role.",
  [ContractError.RoleNotGranted]: "Address does not hold the specified role.",
  [ContractError.InvalidRole]: "Invalid role symbol provided.",
  [ContractError.DeprecatedEntrypoint]: "This entrypoint is deprecated in the current contract version.",
  [ContractError.RecoveryActive]: "Contract is in recovery mode: treasury outflows are blocked.",
};

export class AccordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccordError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class AccordValidationError extends AccordError {
  public readonly field: string;

  constructor(field: string, message: string) {
    super(`Validation failed for '${field}': ${message}`);
    this.name = "AccordValidationError";
    this.field = field;
  }
}

export class AccordContractError extends AccordError {
  public readonly errorCode: ContractError;
  public readonly codeName: string;

  constructor(code: ContractError | number, details?: string) {
    const errorEnum = code as ContractError;
    const codeName = ContractError[errorEnum] || `UnknownError_${code}`;
    const baseMessage = ERROR_MESSAGES[errorEnum] || `Contract invocation failed with error code ${code}.`;
    const fullMessage = details ? `${baseMessage} (${details})` : baseMessage;

    super(`[${codeName} (#${code})] ${fullMessage}`);
    this.name = "AccordContractError";
    this.errorCode = errorEnum;
    this.codeName = codeName;
  }
}

export class AccordRpcError extends AccordError {
  public readonly originalError?: unknown;

  constructor(message: string, originalError?: unknown) {
    super(message);
    this.name = "AccordRpcError";
    this.originalError = originalError;
  }
}

export function parseContractError(err: unknown): AccordError {
  if (err instanceof AccordError) {
    return err;
  }

  const errStr = String(err);

  // Look for Soroban contract error pattern: Error(Contract, #123) or Error(Contract, 123)
  const match = errStr.match(/Error\(Contract,\s*#?(\d+)\)/);
  if (match && match[1]) {
    const code = parseInt(match[1], 10);
    return new AccordContractError(code);
  }

  return new AccordRpcError(errStr, err);
}
