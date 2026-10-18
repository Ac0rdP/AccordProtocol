/**
 * AccordClient — TypeScript client for Accord Protocol smart contracts on Stellar Soroban.
 * Zero secrets custody: signing is delegated via caller-provided callback.
 * Simulation-based reads, address validation, full bigint precision.
 */

import {
  Account,
  Address,
  Contract,
  Keypair,
  rpc,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import type {
  AssetTransfer,
  CreateRecurringParams,
  Delegation,
  DelegationInfo,
  ModifyRecurringParams,
  OwnerWeight,
  Proposal,
  ProposalApprovalProgress,
  ProposalCategory,
  RecurringPayment,
  Role,
  SpendingLimitEntry,
  SpentTracker,
  Transfer,
} from "./types.js";
import {
  AccordContractError,
  AccordError,
  AccordRpcError,
  AccordValidationError,
  parseContractError,
} from "./errors.js";
import {
  addressToScVal,
  assetTransfersToScVal,
  boolToScVal,
  bytes32ToScVal,
  categoryToScVal,
  createRecurringParamsToScVal,
  i128ToScVal,
  modifyRecurringParamsToScVal,
  optionalBytes32ToScVal,
  ownerWeightsToScVal,
  roleToScVal,
  scValToAddress,
  scValToAddressList,
  scValToBigInt,
  scValToBool,
  scValToDelegationInfo,
  scValToNumber,
  scValToOwnerWeights,
  scValToProposal,
  scValToProposalApprovalProgress,
  scValToRecurringPayment,
  scValToSpendingLimits,
  scValToSpentTracker,
  scValToString,
  stringToScVal,
  symbolToScVal,
  transfersToScVal,
  u32ToScVal,
  u64ToScVal,
} from "./conversion.js";
import {
  validateAddress,
  validateAddresses,
  validateDeadline,
  validateDescription,
  validatePositiveAmount,
  validateThreshold,
  validateWeight,
} from "./validation.js";

export interface AccordClientConfig {
  /** Contract address (C...) */
  contractId: string;
  /** Stellar / Soroban RPC URL */
  rpcUrl: string;
  /** Stellar network passphrase */
  networkPassphrase: string;
  /** Optional signing callback: signs the prepared Transaction and returns it */
  signTransaction?: (tx: Transaction) => Promise<Transaction> | Transaction;
  /** Source account address for building simulation transactions (non-signing) */
  sourceAccount?: string;
  /** Base fee in stroops (default: "100") */
  fee?: string;
  /** Transaction timeout in seconds (default: 30) */
  timeoutSeconds?: number;
}

export class AccordClient {
  public readonly contractId: string;
  public readonly rpcUrl: string;
  public readonly networkPassphrase: string;
  public readonly server: rpc.Server;
  private readonly contract: Contract;
  private readonly signTransactionFn?: (tx: Transaction) => Promise<Transaction> | Transaction;
  private readonly sourceAccount?: string;
  private readonly fee: string;
  private readonly timeoutSeconds: number;

  constructor(config: AccordClientConfig) {
    validateAddress(config.contractId, "contractId");
    if (!config.rpcUrl) {
      throw new AccordValidationError("rpcUrl", "RPC URL cannot be empty.");
    }
    if (!config.networkPassphrase) {
      throw new AccordValidationError("networkPassphrase", "Network passphrase cannot be empty.");
    }

    this.contractId = config.contractId;
    this.rpcUrl = config.rpcUrl;
    this.networkPassphrase = config.networkPassphrase;
    this.server = new rpc.Server(this.rpcUrl);
    this.contract = new Contract(this.contractId);
    this.signTransactionFn = config.signTransaction;
    this.sourceAccount = config.sourceAccount;
    this.fee = config.fee ?? "100";
    this.timeoutSeconds = config.timeoutSeconds ?? 30;
  }

  // ─── Simulation & Execution Core ─────────────────────────────────────────

  /**
   * Simulates a read-only view call to the contract.
   */
  public async simulateView(fnName: string, args: xdr.ScVal[] = []): Promise<xdr.ScVal> {
    try {
      const simSource = this.sourceAccount || Keypair.random().publicKey();
      let account: Account;
      try {
        account = await this.server.getAccount(simSource);
      } catch {
        account = new Account(simSource, "0");
      }

      const tx = new TransactionBuilder(account, {
        fee: this.fee,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(this.contract.call(fnName, ...args))
        .setTimeout(this.timeoutSeconds)
        .build();

      const sim = await this.server.simulateTransaction(tx);
      if (!rpc.Api.isSimulationSuccess(sim)) {
        const errSim = sim as rpc.Api.SimulateTransactionErrorResponse;
        throw parseContractError(errSim.error || "Simulation failed");
      }

      const success = sim as rpc.Api.SimulateTransactionSuccessResponse;
      if (!success.result || !success.result.retval) {
        return xdr.ScVal.scvVoid();
      }
      return success.result.retval;
    } catch (err: unknown) {
      if (err instanceof AccordError) throw err;
      throw parseContractError(err);
    }
  }

  /**
   * Builds, simulates, signs, and submits a state-changing transaction.
   */
  public async executeTransaction(
    fnName: string,
    args: xdr.ScVal[],
    callerAddress: string
  ): Promise<string> {
    validateAddress(callerAddress, "callerAddress");
    if (!this.signTransactionFn) {
      throw new AccordValidationError(
        "signTransaction",
        "A signing callback ('signTransaction') must be configured to execute state-changing transactions."
      );
    }

    try {
      const account = await this.server.getAccount(callerAddress);
      const rawTx = new TransactionBuilder(account, {
        fee: this.fee,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(this.contract.call(fnName, ...args))
        .setTimeout(this.timeoutSeconds)
        .build();

      const sim = await this.server.simulateTransaction(rawTx);
      if (!rpc.Api.isSimulationSuccess(sim)) {
        const errSim = sim as rpc.Api.SimulateTransactionErrorResponse;
        throw parseContractError(errSim.error || `Simulation of '${fnName}' failed.`);
      }

      const preparedTx = rpc.assembleTransaction(rawTx, sim).build();
      const signedTx = await this.signTransactionFn(preparedTx);

      const sendResp = await this.server.sendTransaction(signedTx);
      if (sendResp.status === "ERROR") {
        throw new AccordRpcError(`Transaction submission failed: ${JSON.stringify(sendResp.errorResult)}`);
      }

      return sendResp.hash;
    } catch (err: unknown) {
      if (err instanceof AccordError) throw err;
      throw parseContractError(err);
    }
  }

  // ─── View Methods ─────────────────────────────────────────────────────────

  public async getProposal(proposalId: bigint | number): Promise<Proposal> {
    const scVal = await this.simulateView("get_proposal", [u64ToScVal(proposalId)]);
    return scValToProposal(scVal);
  }

  public async getProposalsPaged(offset: bigint | number, limit = 20): Promise<Proposal[]> {
    const scVal = await this.simulateView("get_proposals_paged", [
      u64ToScVal(offset),
      u32ToScVal(limit),
    ]);
    const native = scValToProposalList(scVal);
    return native;
  }

  public async getOwners(): Promise<string[]> {
    const scVal = await this.simulateView("get_owners", []);
    return scValToAddressList(scVal);
  }

  public async getThreshold(): Promise<number> {
    const scVal = await this.simulateView("get_threshold", []);
    return scValToNumber(scVal);
  }

  public async getRequiredQuorumWeight(): Promise<number> {
    const scVal = await this.simulateView("get_required_quorum_weight", []);
    return scValToNumber(scVal);
  }

  public async getTotalWeight(): Promise<number> {
    const scVal = await this.simulateView("get_total_weight", []);
    return scValToNumber(scVal);
  }

  public async getOwnerWeight(owner: string): Promise<number> {
    validateAddress(owner, "owner");
    const scVal = await this.simulateView("get_owner_weight", [addressToScVal(owner)]);
    return scValToNumber(scVal);
  }

  public async getOwnerWeights(): Promise<OwnerWeight[]> {
    const scVal = await this.simulateView("get_owner_weights", []);
    return scValToOwnerWeights(scVal);
  }

  public async getMaxSingleOwnerWeightPct(): Promise<number> {
    const scVal = await this.simulateView("get_max_single_owner_weight_pct", []);
    return scValToNumber(scVal);
  }

  public async getEffectiveWeight(owner: string): Promise<number> {
    validateAddress(owner, "owner");
    const scVal = await this.simulateView("get_effective_weight", [addressToScVal(owner)]);
    return scValToNumber(scVal);
  }

  public async getDelegations(owner: string): Promise<DelegationInfo> {
    validateAddress(owner, "owner");
    const scVal = await this.simulateView("get_delegations", [addressToScVal(owner)]);
    return scValToDelegationInfo(scVal);
  }

  public async getActiveDelegations(): Promise<Delegation[]> {
    const scVal = await this.simulateView("get_active_delegations", []);
    const info = scValToDelegationInfo(scVal);
    return info.outgoing;
  }

  public async isOwner(address: string): Promise<boolean> {
    validateAddress(address, "address");
    const scVal = await this.simulateView("is_owner", [addressToScVal(address)]);
    return scValToBool(scVal);
  }

  public async hasApproved(proposalId: bigint | number, owner: string): Promise<boolean> {
    validateAddress(owner, "owner");
    const scVal = await this.simulateView("has_approved", [
      u64ToScVal(proposalId),
      addressToScVal(owner),
    ]);
    return scValToBool(scVal);
  }

  public async getProposalApprovalProgress(
    proposalId: bigint | number
  ): Promise<ProposalApprovalProgress> {
    const scVal = await this.simulateView("get_proposal_approval_progress", [
      u64ToScVal(proposalId),
    ]);
    return scValToProposalApprovalProgress(scVal);
  }

  public async getApprovers(proposalId: bigint | number): Promise<string[]> {
    const scVal = await this.simulateView("get_approvers", [u64ToScVal(proposalId)]);
    return scValToAddressList(scVal);
  }

  public async getTimeLockDelay(): Promise<bigint> {
    const scVal = await this.simulateView("get_time_lock_delay", []);
    return scValToBigInt(scVal);
  }

  public async getTotalProposals(): Promise<bigint> {
    const scVal = await this.simulateView("get_total_proposals", []);
    return scValToBigInt(scVal);
  }

  public async getVersion(): Promise<number> {
    const scVal = await this.simulateView("get_version", []);
    return scValToNumber(scVal);
  }

  public async getStorageVersion(): Promise<number> {
    const scVal = await this.simulateView("get_storage_version", []);
    return scValToNumber(scVal);
  }

  public async getRoleVersion(): Promise<number> {
    const scVal = await this.simulateView("get_role_version", []);
    return scValToNumber(scVal);
  }

  public async isGovernanceMigrated(): Promise<boolean> {
    const scVal = await this.simulateView("is_governance_migrated", []);
    return scValToBool(scVal);
  }

  public async getRoles(address: string): Promise<Role[]> {
    validateAddress(address, "address");
    const scVal = await this.simulateView("get_roles", [addressToScVal(address)]);
    return scValToAddressList(scVal) as Role[];
  }

  public async hasRole(address: string, role: Role): Promise<boolean> {
    validateAddress(address, "address");
    const scVal = await this.simulateView("has_role", [
      addressToScVal(address),
      roleToScVal(role),
    ]);
    return scValToBool(scVal);
  }

  public async getRoleMembers(role: Role): Promise<string[]> {
    const scVal = await this.simulateView("get_role_members", [roleToScVal(role)]);
    return scValToAddressList(scVal);
  }

  public async getSpendingLimit(owner: string, token: string): Promise<bigint | null> {
    validateAddress(owner, "owner");
    validateAddress(token, "token");
    const scVal = await this.simulateView("get_spending_limit", [
      addressToScVal(owner),
      addressToScVal(token),
    ]);
    if (scVal.switch() === xdr.ScValType.scvVoid()) return null;
    return scValToBigInt(scVal);
  }

  public async getOwnerSpendingLimits(owner: string): Promise<SpendingLimitEntry[]> {
    validateAddress(owner, "owner");
    const scVal = await this.simulateView("get_owner_spending_limits", [addressToScVal(owner)]);
    return scValToSpendingLimits(scVal);
  }

  public async getRemainingSpendingLimit(owner: string, token: string): Promise<bigint | null> {
    validateAddress(owner, "owner");
    validateAddress(token, "token");
    const scVal = await this.simulateView("get_remaining_spending_limit", [
      addressToScVal(owner),
      addressToScVal(token),
    ]);
    if (scVal.switch() === xdr.ScValType.scvVoid()) return null;
    return scValToBigInt(scVal);
  }

  public async getSpendingWindow(owner: string, token: string): Promise<bigint> {
    validateAddress(owner, "owner");
    validateAddress(token, "token");
    const scVal = await this.simulateView("get_spending_window", [
      addressToScVal(owner),
      addressToScVal(token),
    ]);
    return scValToBigInt(scVal);
  }

  public async getSpentTracker(owner: string, token: string): Promise<SpentTracker> {
    validateAddress(owner, "owner");
    validateAddress(token, "token");
    const scVal = await this.simulateView("get_spent_tracker", [
      addressToScVal(owner),
      addressToScVal(token),
    ]);
    return scValToSpentTracker(scVal);
  }

  public async getClassicAsset(identifier: string): Promise<string | null> {
    const scVal = await this.simulateView("get_classic_asset", [symbolToScVal(identifier)]);
    if (scVal.switch() === xdr.ScValType.scvVoid()) return null;
    return scValToAddress(scVal);
  }

  public async getGuardian(): Promise<string | null> {
    const scVal = await this.simulateView("get_guardian", []);
    if (scVal.switch() === xdr.ScValType.scvVoid()) return null;
    return scValToAddress(scVal);
  }

  public async isFrozen(): Promise<boolean> {
    const scVal = await this.simulateView("is_frozen", []);
    return scValToBool(scVal);
  }

  public async isInRecovery(): Promise<boolean> {
    const scVal = await this.simulateView("is_in_recovery", []);
    return scValToBool(scVal);
  }

  public async getRecurringPayment(scheduleId: bigint | number): Promise<RecurringPayment> {
    const scVal = await this.simulateView("get_recurring_payment", [u64ToScVal(scheduleId)]);
    return scValToRecurringPayment(scVal);
  }

  public async getNextDisbursementTime(scheduleId: bigint | number): Promise<bigint> {
    const scVal = await this.simulateView("get_next_disbursement_time", [u64ToScVal(scheduleId)]);
    return scValToBigInt(scVal);
  }

  public async getRecurringPaymentsPaged(
    offset: bigint | number,
    limit = 20
  ): Promise<RecurringPayment[]> {
    const scVal = await this.simulateView("get_recurring_payments_paged", [
      u64ToScVal(offset),
      u32ToScVal(limit),
    ]);
    return scValToRecurringPaymentList(scVal);
  }

  public async getActiveRecurringCount(): Promise<number> {
    const scVal = await this.simulateView("get_active_recurring_count", []);
    return scValToNumber(scVal);
  }

  // ─── State-Changing Methods ───────────────────────────────────────────────

  public async initialize(
    caller: string,
    owners: string[],
    threshold: number,
    timeLock = 0n,
    weights?: number[]
  ): Promise<string> {
    validateAddress(caller, "caller");
    validateAddresses(owners, "owners");
    validateThreshold(threshold);

    const args = [
      xdr.ScVal.scvVec(owners.map(addressToScVal)),
      u32ToScVal(threshold),
      u64ToScVal(timeLock),
    ];
    if (weights) {
      args.push(xdr.ScVal.scvVec(weights.map(u32ToScVal)));
    }

    return this.executeTransaction("initialize", args, caller);
  }

  public async createProposal(
    proposer: string,
    transfers: Transfer[],
    description: string,
    deadline: bigint,
    category: ProposalCategory = "Transfer"
  ): Promise<string> {
    validateAddress(proposer, "proposer");
    validateDescription(description);
    validateDeadline(deadline);
    for (const t of transfers) {
      validateAddress(t.to, "transfer.to");
      validateAddress(t.token, "transfer.token");
      validatePositiveAmount(t.amount, "transfer.amount");
    }

    const args = [
      addressToScVal(proposer),
      transfersToScVal(transfers),
      stringToScVal(description),
      u64ToScVal(deadline),
      categoryToScVal(category),
    ];

    return this.executeTransaction("create_proposal", args, proposer);
  }

  public async createProposalWithAttachment(
    proposer: string,
    transfers: Transfer[],
    description: string,
    deadline: bigint,
    category: ProposalCategory = "Transfer",
    attachmentHash?: string | Uint8Array | null
  ): Promise<string> {
    validateAddress(proposer, "proposer");
    validateDescription(description);
    validateDeadline(deadline);

    const args = [
      addressToScVal(proposer),
      transfersToScVal(transfers),
      stringToScVal(description),
      u64ToScVal(deadline),
      categoryToScVal(category),
      optionalBytes32ToScVal(attachmentHash),
    ];

    return this.executeTransaction("create_proposal_with_attachment", args, proposer);
  }

  public async createAssetProposal(
    proposer: string,
    transfers: AssetTransfer[],
    description: string,
    deadline: bigint,
    category: ProposalCategory = "Transfer"
  ): Promise<string> {
    validateAddress(proposer, "proposer");
    validateDescription(description);
    validateDeadline(deadline);

    const args = [
      addressToScVal(proposer),
      assetTransfersToScVal(transfers),
      stringToScVal(description),
      u64ToScVal(deadline),
      categoryToScVal(category),
    ];

    return this.executeTransaction("create_asset_proposal", args, proposer);
  }

  public async createAddOwnerProposal(
    proposer: string,
    newOwner: string,
    weight: number,
    description: string,
    deadline: bigint,
    category: ProposalCategory = "Ops"
  ): Promise<string> {
    validateAddress(proposer, "proposer");
    validateAddress(newOwner, "newOwner");
    validateWeight(weight);
    validateDescription(description);
    validateDeadline(deadline);

    const args = [
      addressToScVal(proposer),
      addressToScVal(newOwner),
      u32ToScVal(weight),
      stringToScVal(description),
      u64ToScVal(deadline),
      categoryToScVal(category),
    ];

    return this.executeTransaction("create_add_owner_proposal", args, proposer);
  }

  public async createRemoveOwnerProposal(
    proposer: string,
    ownerToRemove: string,
    description: string,
    deadline: bigint,
    category: ProposalCategory = "Ops"
  ): Promise<string> {
    validateAddress(proposer, "proposer");
    validateAddress(ownerToRemove, "ownerToRemove");
    validateDescription(description);
    validateDeadline(deadline);

    const args = [
      addressToScVal(proposer),
      addressToScVal(ownerToRemove),
      stringToScVal(description),
      u64ToScVal(deadline),
      categoryToScVal(category),
    ];

    return this.executeTransaction("create_remove_owner_proposal", args, proposer);
  }

  public async createChangeThresholdProposal(
    proposer: string,
    newThreshold: number,
    description: string,
    deadline: bigint,
    category: ProposalCategory = "Ops"
  ): Promise<string> {
    validateAddress(proposer, "proposer");
    validateThreshold(newThreshold);
    validateDescription(description);
    validateDeadline(deadline);

    const args = [
      addressToScVal(proposer),
      u32ToScVal(newThreshold),
      stringToScVal(description),
      u64ToScVal(deadline),
      categoryToScVal(category),
    ];

    return this.executeTransaction("create_change_threshold_proposal", args, proposer);
  }

  public async createChangeWeightProposal(
    proposer: string,
    targetOwner: string,
    newWeight: number,
    description: string,
    deadline: bigint,
    category: ProposalCategory = "Ops"
  ): Promise<string> {
    validateAddress(proposer, "proposer");
    validateAddress(targetOwner, "targetOwner");
    validateWeight(newWeight);
    validateDescription(description);
    validateDeadline(deadline);

    const args = [
      addressToScVal(proposer),
      addressToScVal(targetOwner),
      u32ToScVal(newWeight),
      stringToScVal(description),
      u64ToScVal(deadline),
      categoryToScVal(category),
    ];

    return this.executeTransaction("create_change_weight_proposal", args, proposer);
  }

  public async createSpendingLimitProposal(
    proposer: string,
    owner: string,
    token: string,
    limit: bigint,
    description: string,
    deadline: bigint,
    category: ProposalCategory = "Ops"
  ): Promise<string> {
    validateAddress(proposer, "proposer");
    validateAddress(owner, "owner");
    validateAddress(token, "token");
    validateDescription(description);
    validateDeadline(deadline);

    const args = [
      addressToScVal(proposer),
      addressToScVal(owner),
      addressToScVal(token),
      i128ToScVal(limit),
      stringToScVal(description),
      u64ToScVal(deadline),
      categoryToScVal(category),
    ];

    return this.executeTransaction("create_spending_limit_proposal", args, proposer);
  }

  public async createSpendingWindowProposal(
    proposer: string,
    owner: string,
    token: string,
    limit: bigint,
    windowSecs: bigint,
    description: string,
    deadline: bigint,
    category: ProposalCategory = "Ops"
  ): Promise<string> {
    validateAddress(proposer, "proposer");
    validateAddress(owner, "owner");
    validateAddress(token, "token");
    validateDescription(description);
    validateDeadline(deadline);

    const args = [
      addressToScVal(proposer),
      addressToScVal(owner),
      addressToScVal(token),
      i128ToScVal(limit),
      u64ToScVal(windowSecs),
      stringToScVal(description),
      u64ToScVal(deadline),
      categoryToScVal(category),
    ];

    return this.executeTransaction("create_spending_window_proposal", args, proposer);
  }

  public async createRecurringProposal(
    proposer: string,
    params: CreateRecurringParams,
    description: string,
    deadline: bigint,
    category: ProposalCategory = "Transfer"
  ): Promise<string> {
    validateAddress(proposer, "proposer");
    validateAddress(params.recipient, "params.recipient");
    validateAddress(params.token, "params.token");
    validatePositiveAmount(params.amount, "params.amount");
    validateDescription(description);
    validateDeadline(deadline);

    const args = [
      addressToScVal(proposer),
      createRecurringParamsToScVal(params),
      stringToScVal(description),
      u64ToScVal(deadline),
      categoryToScVal(category),
    ];

    return this.executeTransaction("create_recurring_proposal", args, proposer);
  }

  public async createCancelRecurringProposal(
    proposer: string,
    scheduleId: bigint | number,
    description: string,
    deadline: bigint,
    category: ProposalCategory = "Ops"
  ): Promise<string> {
    validateAddress(proposer, "proposer");
    validateDescription(description);
    validateDeadline(deadline);

    const args = [
      addressToScVal(proposer),
      u64ToScVal(scheduleId),
      stringToScVal(description),
      u64ToScVal(deadline),
      categoryToScVal(category),
    ];

    return this.executeTransaction("create_cancel_recurring_proposal", args, proposer);
  }

  public async createPauseRecurringProposal(
    proposer: string,
    scheduleId: bigint | number,
    description: string,
    deadline: bigint,
    category: ProposalCategory = "Ops"
  ): Promise<string> {
    validateAddress(proposer, "proposer");
    validateDescription(description);
    validateDeadline(deadline);

    const args = [
      addressToScVal(proposer),
      u64ToScVal(scheduleId),
      stringToScVal(description),
      u64ToScVal(deadline),
      categoryToScVal(category),
    ];

    return this.executeTransaction("create_pause_recurring_proposal", args, proposer);
  }

  public async createResumeRecurringProposal(
    proposer: string,
    scheduleId: bigint | number,
    description: string,
    deadline: bigint,
    category: ProposalCategory = "Ops"
  ): Promise<string> {
    validateAddress(proposer, "proposer");
    validateDescription(description);
    validateDeadline(deadline);

    const args = [
      addressToScVal(proposer),
      u64ToScVal(scheduleId),
      stringToScVal(description),
      u64ToScVal(deadline),
      categoryToScVal(category),
    ];

    return this.executeTransaction("create_resume_recurring_proposal", args, proposer);
  }

  public async createModifyRecurringProposal(
    proposer: string,
    params: ModifyRecurringParams,
    description: string,
    deadline: bigint,
    category: ProposalCategory = "Ops"
  ): Promise<string> {
    validateAddress(proposer, "proposer");
    validateDescription(description);
    validateDeadline(deadline);

    const args = [
      addressToScVal(proposer),
      modifyRecurringParamsToScVal(params),
      stringToScVal(description),
      u64ToScVal(deadline),
      categoryToScVal(category),
    ];

    return this.executeTransaction("create_modify_recurring_proposal", args, proposer);
  }

  public async createGrantRoleProposal(
    proposer: string,
    target: string,
    role: Role,
    description: string,
    deadline: bigint,
    category: ProposalCategory = "Ops"
  ): Promise<string> {
    validateAddress(proposer, "proposer");
    validateAddress(target, "target");
    validateDescription(description);
    validateDeadline(deadline);

    const args = [
      addressToScVal(proposer),
      addressToScVal(target),
      roleToScVal(role),
      stringToScVal(description),
      u64ToScVal(deadline),
      categoryToScVal(category),
    ];

    return this.executeTransaction("create_grant_role_proposal", args, proposer);
  }

  public async createRevokeRoleProposal(
    proposer: string,
    target: string,
    role: Role,
    description: string,
    deadline: bigint,
    category: ProposalCategory = "Ops"
  ): Promise<string> {
    validateAddress(proposer, "proposer");
    validateAddress(target, "target");
    validateDescription(description);
    validateDeadline(deadline);

    const args = [
      addressToScVal(proposer),
      addressToScVal(target),
      roleToScVal(role),
      stringToScVal(description),
      u64ToScVal(deadline),
      categoryToScVal(category),
    ];

    return this.executeTransaction("create_revoke_role_proposal", args, proposer);
  }

  public async approve(approver: string, proposalId: bigint | number): Promise<string> {
    validateAddress(approver, "approver");
    return this.executeTransaction(
      "approve",
      [addressToScVal(approver), u64ToScVal(proposalId)],
      approver
    );
  }

  public async revoke(approver: string, proposalId: bigint | number): Promise<string> {
    validateAddress(approver, "approver");
    return this.executeTransaction(
      "revoke",
      [addressToScVal(approver), u64ToScVal(proposalId)],
      approver
    );
  }

  public async execute(executor: string, proposalId: bigint | number): Promise<string> {
    validateAddress(executor, "executor");
    return this.executeTransaction(
      "execute",
      [addressToScVal(executor), u64ToScVal(proposalId)],
      executor
    );
  }

  public async cancelExpired(caller: string, ids: (bigint | number)[]): Promise<string> {
    validateAddress(caller, "caller");
    const args = [
      addressToScVal(caller),
      xdr.ScVal.scvVec(ids.map((id) => u64ToScVal(id))),
    ];
    return this.executeTransaction("cancel_expired", args, caller);
  }

  public async disburseRecurring(
    caller: string,
    scheduleId: bigint | number
  ): Promise<string> {
    validateAddress(caller, "caller");
    return this.executeTransaction(
      "disburse_recurring",
      [addressToScVal(caller), u64ToScVal(scheduleId)],
      caller
    );
  }

  public async setGuardian(approvers: string[], newGuardian: string): Promise<string> {
    validateAddresses(approvers, "approvers");
    validateAddress(newGuardian, "newGuardian");

    const caller = approvers[0];
    const args = [
      xdr.ScVal.scvVec(approvers.map(addressToScVal)),
      addressToScVal(newGuardian),
    ];
    return this.executeTransaction("set_guardian", args, caller);
  }

  public async freeze(guardian: string): Promise<string> {
    validateAddress(guardian, "guardian");
    return this.executeTransaction("freeze", [addressToScVal(guardian)], guardian);
  }

  public async unfreeze(approvers: string[]): Promise<string> {
    validateAddresses(approvers, "approvers");
    const caller = approvers[0];
    const args = [xdr.ScVal.scvVec(approvers.map(addressToScVal))];
    return this.executeTransaction("unfreeze", args, caller);
  }

  public async enterRecovery(guardian: string): Promise<string> {
    validateAddress(guardian, "guardian");
    return this.executeTransaction("enter_recovery", [addressToScVal(guardian)], guardian);
  }

  public async exitRecovery(approvers: string[]): Promise<string> {
    validateAddresses(approvers, "approvers");
    const caller = approvers[0];
    const args = [xdr.ScVal.scvVec(approvers.map(addressToScVal))];
    return this.executeTransaction("exit_recovery", args, caller);
  }

  public async setClassicAsset(
    approvers: string[],
    identifier: string,
    sac: string
  ): Promise<string> {
    validateAddresses(approvers, "approvers");
    validateAddress(sac, "sac");
    const caller = approvers[0];
    const args = [
      xdr.ScVal.scvVec(approvers.map(addressToScVal)),
      symbolToScVal(identifier),
      addressToScVal(sac),
    ];
    return this.executeTransaction("set_classic_asset", args, caller);
  }

  public async setMaxSingleOwnerWeightPct(
    approvers: string[],
    maxPct: number
  ): Promise<string> {
    validateAddresses(approvers, "approvers");
    if (!Number.isInteger(maxPct) || maxPct < 1 || maxPct > 50) {
      throw new AccordValidationError("maxPct", "maxPct must be an integer between 1 and 50.");
    }
    const caller = approvers[0];
    const args = [
      xdr.ScVal.scvVec(approvers.map(addressToScVal)),
      u32ToScVal(maxPct),
    ];
    return this.executeTransaction("set_max_single_owner_weight_pct", args, caller);
  }

  public async upgrade(approvers: string[], newWasmHash: string | Uint8Array): Promise<string> {
    validateAddresses(approvers, "approvers");
    const caller = approvers[0];
    const args = [
      xdr.ScVal.scvVec(approvers.map(addressToScVal)),
      bytes32ToScVal(newWasmHash),
    ];
    return this.executeTransaction("upgrade", args, caller);
  }

  public async migrateToWeightedGovernance(
    approvers: string[],
    weights: OwnerWeight[]
  ): Promise<string> {
    validateAddresses(approvers, "approvers");
    const caller = approvers[0];
    const args = [
      xdr.ScVal.scvVec(approvers.map(addressToScVal)),
      ownerWeightsToScVal(weights),
    ];
    return this.executeTransaction("migrate_to_weighted_governance", args, caller);
  }

  public async migrateToRbac(approvers: string[]): Promise<string> {
    validateAddresses(approvers, "approvers");
    const caller = approvers[0];
    const args = [xdr.ScVal.scvVec(approvers.map(addressToScVal))];
    return this.executeTransaction("migrate_to_rbac", args, caller);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function scValToProposalList(scVal: xdr.ScVal): Proposal[] {
  if (scVal.switch() !== xdr.ScValType.scvVec() || !scVal.vec()) {
    return [];
  }
  return scVal.vec()!.map(scValToProposal);
}

function scValToRecurringPaymentList(scVal: xdr.ScVal): RecurringPayment[] {
  if (scVal.switch() !== xdr.ScValType.scvVec() || !scVal.vec()) {
    return [];
  }
  return scVal.vec()!.map(scValToRecurringPayment);
}
