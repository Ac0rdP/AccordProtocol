import {
  Account,
  Contract,
  FeeBumpTransaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import type { MobileConfig } from "../config";
import { mapApprovalState, mapProposal } from "./mapping";
import { hashToHex, isValidWalletAddress, signedTransactionHash } from "./wallet";
import type { ApprovalState, PreparedApproval, Proposal } from "./types";

/** Structurally the subset of `rpc.Server` used by the mobile client. */
export interface RpcTransport {
  getAccount(address: string): Promise<Account>;
  simulateTransaction(tx: Transaction): Promise<rpc.Api.SimulateTransactionResponse>;
  sendTransaction(tx: Transaction): Promise<rpc.Api.SendTransactionResponse>;
  getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse>;
}

/** Contract entrypoints used by the mobile app (same contract as the web app). */
export const ENTRYPOINTS = {
  getThreshold: "get_threshold",
  getTotalProposals: "get_total_proposals",
  getProposalsPaged: "get_proposals_paged",
  getProposal: "get_proposal",
  hasApproved: "has_approved",
  getApprovalProgress: "get_proposal_approval_progress",
  approve: "approve",
} as const;

const PAGE_SIZE = 50;
const MAX_PAGES = 40;

function simulationError(functionName: string, sim: rpc.Api.SimulateTransactionResponse): Error {
  const error = (sim as rpc.Api.SimulateTransactionErrorResponse).error;
  return new Error(`${functionName}: ${error ?? "simulation failed"}`);
}

export interface MobileClientOptions {
  server?: RpcTransport;
  sleep?: (ms: number) => Promise<void>;
  confirmationAttempts?: number;
}

/**
 * Read-only contract queries plus approval transaction preparation. Signing is
 * deliberately external (wallet deep link); this class never handles secrets.
 */
export class AccordMobileClient {
  private readonly server: RpcTransport;
  private readonly contract: Contract;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly confirmationAttempts: number;
  private readonly simSource: string;

  constructor(
    public readonly config: MobileConfig,
    options: MobileClientOptions = {},
  ) {
    this.server = options.server ?? new rpc.Server(config.rpcUrl);
    this.contract = new Contract(config.contractId);
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.confirmationAttempts = options.confirmationAttempts ?? 15;
    this.simSource = config.simSource || "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
  }

  private async simulateView(functionName: string, args: xdr.ScVal[]): Promise<unknown> {
    let source: Account;
    try {
      source = await this.server.getAccount(this.simSource);
    } catch {
      // Simulation does not require a funded account; a zero sequence is fine.
      source = new Account(this.simSource, "0");
    }
    const tx = new TransactionBuilder(source, {
      fee: "100",
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(this.contract.call(functionName, ...args))
      .setTimeout(30)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(sim)) throw simulationError(functionName, sim);
    return scValToNative(sim.result!.retval);
  }

  async getThreshold(): Promise<number> {
    const value = await this.simulateView(ENTRYPOINTS.getThreshold, []);
    return Number(value ?? 0);
  }

  async getTotalProposals(): Promise<number> {
    const value = await this.simulateView(ENTRYPOINTS.getTotalProposals, []);
    return Number(value ?? 0);
  }

  async getProposal(id: number): Promise<Proposal> {
    const [raw, threshold] = await Promise.all([
      this.simulateView(ENTRYPOINTS.getProposal, [nativeToScVal(BigInt(id), { type: "u64" })]),
      this.getThreshold(),
    ]);
    return mapProposal(raw, threshold);
  }

  /** Paginated reads — identical paging pattern to the web app's contract client. */
  async getProposals(limit = 100): Promise<Proposal[]> {
    const [total, threshold] = await Promise.all([
      this.getTotalProposals(),
      this.getThreshold(),
    ]);
    const proposals: Proposal[] = [];
    for (let offset = 0; offset < total && offset < limit && offset < PAGE_SIZE * MAX_PAGES; offset += PAGE_SIZE) {
      const count = Math.min(PAGE_SIZE, total - offset, limit - offset);
      const page = await this.simulateView(ENTRYPOINTS.getProposalsPaged, [
        nativeToScVal(BigInt(offset), { type: "u64" }),
        nativeToScVal(count, { type: "u32" }),
      ]);
      if (!Array.isArray(page) || page.length === 0) break;
      proposals.push(...page.map((raw) => mapProposal(raw, threshold)));
    }
    return proposals;
  }

  async getApprovalState(id: number): Promise<ApprovalState> {
    const raw = await this.simulateView(ENTRYPOINTS.getApprovalProgress, [
      nativeToScVal(BigInt(id), { type: "u64" }),
    ]);
    return mapApprovalState(raw, await this.getThreshold());
  }

  /**
   * `has_approved(proposal_id: u64, owner: Address)` — argument order is fixed
   * by the contract entrypoint in contracts/accord/src/lib.rs.
   */
  async hasApproved(owner: string, proposalId: number): Promise<boolean> {
    if (!isValidWalletAddress(owner)) return false;
    const raw = await this.simulateView(ENTRYPOINTS.hasApproved, [
      nativeToScVal(BigInt(proposalId), { type: "u64" }),
      nativeToScVal(owner, { type: "address" }),
    ]);
    return Boolean(raw);
  }

  /** Builds and simulates the `approve` call; returns XDR for wallet signing. */
  async prepareApproval(proposalId: number, owner: string): Promise<PreparedApproval> {
    if (!isValidWalletAddress(owner)) throw new Error("Connect a valid Stellar wallet first.");
    const account = await this.server.getAccount(owner);
    const tx = new TransactionBuilder(account, {
      fee: "100000",
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          ENTRYPOINTS.approve,
          nativeToScVal(owner, { type: "address" }),
          nativeToScVal(BigInt(proposalId), { type: "u64" }),
        ),
      )
      .setTimeout(30)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(sim)) throw simulationError(ENTRYPOINTS.approve, sim);
    const prepared = rpc.assembleTransaction(tx, sim).build();
    return {
      proposalId,
      xdr: prepared.toXDR(),
      hash: hashToHex(prepared.hash()),
      sourceAccount: owner,
      contractId: this.config.contractId,
    };
  }

  /** Submits a wallet-signed approval and waits for on-chain confirmation. */
  async submitApproval(signedXdr: string, expectedHash: string): Promise<string> {
    const actualHash = signedTransactionHash(signedXdr, this.config.networkPassphrase);
    if (!actualHash || actualHash !== expectedHash) {
      throw new Error("The signed transaction does not match the approval you reviewed.");
    }
    const signed = TransactionBuilder.fromXDR(signedXdr, this.config.networkPassphrase);
    if (signed instanceof FeeBumpTransaction) {
      throw new Error("Fee-bump transactions are not supported for approvals.");
    }
    const sent = await this.server.sendTransaction(signed);
    if (sent.status === "ERROR") {
      throw new Error(`Approval submission failed: ${JSON.stringify(sent.errorResult)}`);
    }
    const hash = sent.hash;
    for (let attempt = 0; attempt < this.confirmationAttempts; attempt += 1) {
      const result = await this.server.getTransaction(hash);
      if (result.status === "SUCCESS") return hash;
      if (result.status === "FAILED") throw new Error("Approval transaction failed on-chain.");
      await this.sleep(2000);
    }
    throw new Error("Approval was submitted but not confirmed. Check the transaction hash.");
  }
}
