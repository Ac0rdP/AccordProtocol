import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  Account,
  Contract,
  Keypair,
  SorobanDataBuilder,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import {
  DEFAULT_RPC_URL,
  DEFAULT_TESTNET_CONTRACT_ID,
  TESTNET_PASSPHRASE,
  readConfig,
} from "../config";
import { AccordMobileClient, type RpcTransport } from "./contract";
import { signedTransactionHash } from "./wallet";

const owner = Keypair.random();

const rawProposal = (id: number) => ({
  id: BigInt(id),
  description: `Proposal ${id}`,
  deadline: 1_700_000_000n,
  approvals: 1,
  approval_weight: 2,
  quorum_weight: 3,
  status: "Pending",
  proposer: "GPROPOSER",
  kind: { Transfer: [{ to: "GBOB", token: "GUSDC", amount: 1_000_000n }] },
});

class FakeRpc implements RpcTransport {
  readonly calls: Array<{ name: string; args: unknown[]; contractId: string }> = [];
  responses: Record<string, unknown> = {
    get_total_proposals: 2n,
    get_threshold: 3,
    get_proposals_paged: [rawProposal(1), rawProposal(2)],
    get_proposal: rawProposal(1),
    has_approved: true,
    get_proposal_approval_progress: {
      approval_weight: 4n,
      quorum_weight: 6n,
      total_weight: 10n,
    },
  };
  submitted: Transaction[] = [];
  transactionStatuses = ["NOT_FOUND", "SUCCESS"];
  private statusIndex = 0;

  async getAccount(address: string): Promise<Account> {
    return new Account(address, "1");
  }

  async simulateTransaction(tx: Transaction): Promise<rpc.Api.SimulateTransactionResponse> {
    const invocation = (tx.operations[0] as unknown as {
      func: { invokeContract: { functionName: { toString(): string }; args: xdr.ScVal[] } };
    }).func.invokeContract;
    const name = invocation.functionName.toString();
    this.calls.push({
      name,
      args: invocation.args.map((arg) => scValToNative(arg)),
      contractId: DEFAULT_TESTNET_CONTRACT_ID,
    });
    const value = this.responses[name];
    const retval =
      value === null || value === undefined ? xdr.ScVal.scvVoid() : nativeToScVal(value);
    return {
      id: "1",
      latestLedger: 100,
      events: [],
      _parsed: true,
      transactionData: new SorobanDataBuilder(),
      minResourceFee: "100",
      result: { auth: [], retval },
    };
  }

  async sendTransaction(tx: Transaction): Promise<rpc.Api.SendTransactionResponse> {
    this.submitted.push(tx);
    return {
      status: "PENDING",
      hash: Buffer.from(tx.hash()).toString("hex"),
      latestLedger: 100,
    } as unknown as rpc.Api.SendTransactionResponse;
  }

  async getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse> {
    const status = this.transactionStatuses[
      Math.min(this.statusIndex++, this.transactionStatuses.length - 1)
    ];
    return { status, hash } as unknown as rpc.Api.GetTransactionResponse;
  }
}

function makeClient(server: RpcTransport) {
  return new AccordMobileClient(readConfig({}), {
    server,
    sleep: async () => undefined,
    confirmationAttempts: 4,
  });
}

describe("AccordMobileClient", () => {
  let server: FakeRpc;

  beforeEach(() => {
    server = new FakeRpc();
  });

  it("reads the same contract with the web app's paging pattern", async () => {
    const proposals = await makeClient(server).getProposals();
    assert.deepEqual(
      proposals.map((p) => p.id),
      [1, 2],
    );
    assert.equal(proposals[0].status, "pending");
    assert.equal(proposals[0].threshold, 3);
    assert.equal(proposals[0].quorumWeight, 3);
    assert.equal(proposals[0].approvalWeight, 2);
    assert.equal(proposals[0].amount, "0.1");
    const pageCall = server.calls.find((call) => call.name === "get_proposals_paged");
    assert.deepEqual(pageCall?.args, [0n, 2]);
  });

  it("reads approval state and has_approved with contract argument order", async () => {
    const client = makeClient(server);
    assert.deepEqual(await client.getApprovalState(7), {
      approvalWeight: 4,
      quorumWeight: 6,
      totalWeight: 10,
    });
    assert.equal(await client.hasApproved(owner.publicKey(), 7), true);
    const call = server.calls.find((entry) => entry.name === "has_approved");
    assert.deepEqual(call?.args, [7n, owner.publicKey()]);
  });

  it("prepares an approve transaction for wallet signing", async () => {
    const prepared = await makeClient(server).prepareApproval(7, owner.publicKey());
    const call = server.calls.find((entry) => entry.name === "approve");
    assert.deepEqual(call?.args, [owner.publicKey(), 7n]);
    assert.equal(prepared.contractId, DEFAULT_TESTNET_CONTRACT_ID);
    assert.match(prepared.hash, /^[0-9a-f]{64}$/);
    assert.equal(signedTransactionHash(prepared.xdr, TESTNET_PASSPHRASE), prepared.hash);
  });

  it("rejects a signed transaction that differs from the prepared approval", async () => {
    const prepared = await makeClient(server).prepareApproval(7, owner.publicKey());
    const differentAccount = new Account(Keypair.random().publicKey(), "1");
    const differentXdr = new TransactionBuilder(differentAccount, {
      fee: "200000",
      networkPassphrase: TESTNET_PASSPHRASE,
    })
      .addOperation(
        new Contract(DEFAULT_TESTNET_CONTRACT_ID).call(
          "approve",
          nativeToScVal(owner.publicKey(), { type: "address" }),
          nativeToScVal(7n, { type: "u64" }),
        ),
      )
      .setTimeout(30)
      .build()
      .toXDR();

    await assert.rejects(
      makeClient(server).submitApproval(differentXdr, prepared.hash),
      /does not match/,
    );
    assert.equal(server.submitted.length, 0);
  });

  it("submits and confirms a valid signed approval", async () => {
    const client = makeClient(server);
    const prepared = await client.prepareApproval(7, owner.publicKey());
    const signed = TransactionBuilder.fromXDR(prepared.xdr, TESTNET_PASSPHRASE);
    signed.sign(owner);
    const signedXdr = signed.toXDR();

    const hash = await client.submitApproval(signedXdr, prepared.hash);
    assert.equal(hash, signedTransactionHash(signedXdr, TESTNET_PASSPHRASE));
    assert.equal(server.submitted.length, 1);
    assert.equal(server.transactionStatuses.length, 2);
  });

  it("uses the configured RPC endpoint and contract id", () => {
    const client = new AccordMobileClient(
      readConfig({ EXPO_PUBLIC_SOROBAN_RPC_URL: "https://rpc.example" }),
      { server },
    );
    assert.equal(client.config.rpcUrl, "https://rpc.example");
    assert.equal(client.config.contractId, DEFAULT_TESTNET_CONTRACT_ID);
    assert.equal(DEFAULT_RPC_URL, "https://soroban-testnet.stellar.org");
  });
});
