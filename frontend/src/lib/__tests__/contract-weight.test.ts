import { describe, expect, test, vi, beforeEach } from "vitest";
import { xdr } from "@stellar/stellar-sdk";

const TEST_SOURCE = "GDJSB22NWBU7IV44SHHG6WO6AJTUED2KNKWL2DYNJJ5X7M5SG7UVC7JD";
const OWNER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANHUF";

const {
  serverMock,
  transactionBuilderMock,
  contractCallMock,
} = vi.hoisted(() => {
  const serverMock = {
    getAccount: vi.fn(),
    simulateTransaction: vi.fn(),
    getLatestLedger: vi.fn(),
    getEvents: vi.fn(),
    getAccountEntry: vi.fn(),
  };

  const transactionBuilderMock: any = vi.fn().mockImplementation(() => ({
    addOperation: vi.fn().mockReturnThis(),
    setTimeout: vi.fn().mockReturnThis(),
    build: vi.fn(() => ({
      toXDR: () => "BUILT_TX",
    })),
  }));

  const contractCallMock = vi.fn((fn: string, ...args: unknown[]) => ({ fn, args }));
  transactionBuilderMock.fromXDR = vi.fn(() => ({ toXDR: () => "SIGNED_TX" }));

  return { serverMock, transactionBuilderMock, contractCallMock };
});

vi.stubEnv("VITE_SOROBAN_RPC_URL", "https://mock-rpc.test");
vi.stubEnv("VITE_CONTRACT_ADDRESS", "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC");
vi.stubEnv("VITE_NETWORK_PASSPHRASE", "Test SDF Network ; September 2015");
vi.stubEnv("VITE_SIM_SOURCE", TEST_SOURCE);

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
      Api: {
        ...actual.rpc.Api,
        isSimulationSuccess: vi.fn(() => true),
      },
    },
  };
});

const { getOwnerWeight, getTotalWeight, getRequiredQuorumWeight } = await import(
  "../contract"
);

describe("weighted contract reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serverMock.simulateTransaction.mockReset();
    serverMock.getAccount.mockResolvedValue({});
  });

  test("getOwnerWeight returns the mocked weight", async () => {
    serverMock.simulateTransaction.mockResolvedValueOnce({
      result: { retval: xdr.ScVal.scvU32(7) },
    });

    await expect(getOwnerWeight(OWNER)).resolves.toBe(7n);
  });

  test("getOwnerWeight falls back to zero for non-owners", async () => {
    serverMock.simulateTransaction.mockRejectedValueOnce(new Error("OwnerNotFound"));

    await expect(getOwnerWeight(OWNER)).resolves.toBe(0n);
  });

  test("getTotalWeight returns the mocked total weight", async () => {
    serverMock.simulateTransaction.mockResolvedValueOnce({
      result: { retval: xdr.ScVal.scvU32(19) },
    });

    await expect(getTotalWeight()).resolves.toBe(19);
  });

  test("getRequiredQuorumWeight returns the mocked quorum weight", async () => {
    serverMock.simulateTransaction.mockResolvedValueOnce({
      result: { retval: xdr.ScVal.scvU32(11) },
    });

    await expect(getRequiredQuorumWeight()).resolves.toBe(11);
  });
});
