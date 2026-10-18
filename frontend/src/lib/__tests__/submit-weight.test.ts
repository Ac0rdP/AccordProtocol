import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { scValToNative } from "@stellar/stellar-sdk";

const {
  serverMock,
  contractCallMock,
  transactionBuilderMock,
  signTxMock,
} = vi.hoisted(() => {
  const serverMock = {
    getAccount: vi.fn(),
    simulateTransaction: vi.fn(),
    sendTransaction: vi.fn(),
    getTransaction: vi.fn(),
  };

  const contractCallMock = vi.fn((fn: string, ...args: unknown[]) => ({ fn, args }));
  const transactionBuilderMock: any = vi.fn().mockImplementation(() => ({
    addOperation: vi.fn().mockReturnThis(),
    setTimeout: vi.fn().mockReturnThis(),
    build: vi.fn(() => ({
      toXDR: () => "BUILT_TX",
    })),
  }));
  transactionBuilderMock.fromXDR = vi.fn(() => ({ toXDR: () => "SIGNED_TX" }));
  const signTxMock = vi.fn().mockResolvedValue({ ok: true, value: "SIGNED_TX" });

  return { serverMock, contractCallMock, transactionBuilderMock, signTxMock };
});

const CALLER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANHUF";
const TARGET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAS4LU";

vi.stubEnv("VITE_SOROBAN_RPC_URL", "https://mock-rpc.test");
vi.stubEnv("VITE_CONTRACT_ADDRESS", "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC");
vi.stubEnv("VITE_NETWORK_PASSPHRASE", "Test SDF Network ; September 2015");

vi.mock("@stellar/stellar-sdk", async () => {
  const actual = await vi.importActual<any>("@stellar/stellar-sdk");

  class ContractMock {
    call = contractCallMock;
    constructor(_contractId: string) {}
  }

  return {
    ...actual,
    Contract: ContractMock,
    TransactionBuilder: transactionBuilderMock,
    rpc: {
      ...actual.rpc,
      Server: vi.fn(() => serverMock),
      assembleTransaction: vi.fn(() => ({ build: () => ({ toXDR: () => "ASSEMBLED_TX" }) })),
      Api: {
        ...actual.rpc.Api,
        isSimulationSuccess: vi.fn(() => true),
      },
    },
  };
});

vi.mock("../wallet", () => ({
  signTx: signTxMock,
}));

const { createChangeOwnerWeightProposal } = await import("../submit");

describe("weighted proposal submission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: TimerHandler) => {
      if (typeof callback === "function") {
        callback();
      }
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    serverMock.getAccount.mockResolvedValue({});
    serverMock.simulateTransaction.mockResolvedValue({
      result: { retval: undefined },
      minResourceFee: "100",
    });
    serverMock.sendTransaction.mockResolvedValue({ status: "PENDING", hash: "mock-hash" });
    serverMock.getTransaction.mockResolvedValue({ status: "SUCCESS" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("forwards the change-owner-weight arguments to the contract call", async () => {
    await createChangeOwnerWeightProposal(
      CALLER,
      TARGET,
      7,
      "Rebalance signer weight",
      1_234_567_890n
    );

    expect(contractCallMock).toHaveBeenCalledTimes(1);
    expect(contractCallMock).toHaveBeenCalledWith(
      "create_change_weight_proposal",
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything()
    );

    const args = contractCallMock.mock.calls[0].slice(1).map((value) => scValToNative(value as never));
    expect(args).toEqual([
      CALLER,
      TARGET,
      7,
      "Rebalance signer weight",
      1_234_567_890n,
    ]);
  });
});
