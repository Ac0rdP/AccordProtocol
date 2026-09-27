import { describe, expect, test, vi, beforeEach } from "vitest";
import { xdr } from "@stellar/stellar-sdk";

const TEST_SOURCE = "GDJSB22NWBU7IV44SHHG6WO6AJTUED2KNKWL2DYNJJ5X7M5SG7UVC7JD";

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
vi.stubEnv(
  "VITE_CONTRACT_ADDRESS",
  "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
);
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

const { getRoles, hasRole, getRoleMembers } = await import("../contract");

describe("role wrapper reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serverMock.simulateTransaction.mockReset();
    serverMock.getAccount.mockResolvedValue({});
  });

  test("getRoles decodes populated role sets into the frontend Role union", async () => {
    serverMock.simulateTransaction.mockResolvedValueOnce({
      result: {
        retval: xdr.ScVal.scvVec([
          xdr.ScVal.scvSymbol("Owner"),
          xdr.ScVal.scvSymbol("Guardian"),
          xdr.ScVal.scvSymbol("Admin"),
        ]),
      },
    });

    await expect(getRoles()).resolves.toEqual(["owner", "guardian", "admin"]);
  });

  test("getRoles returns an empty array when the role set is empty", async () => {
    serverMock.simulateTransaction.mockResolvedValueOnce({
      result: { retval: xdr.ScVal.scvVec([]) },
    });

    await expect(getRoles()).resolves.toEqual([]);
  });

  test("hasRole returns true when the wallet owns the requested role", async () => {
    serverMock.simulateTransaction.mockResolvedValueOnce({
      result: { retval: xdr.ScVal.scvBool(true) },
    });

    await expect(hasRole(TEST_SOURCE, "admin")).resolves.toBe(true);
  });

  test("hasRole returns false when the wallet does not hold the role", async () => {
    serverMock.simulateTransaction.mockResolvedValueOnce({
      result: { retval: xdr.ScVal.scvBool(false) },
    });

    await expect(hasRole(TEST_SOURCE, "guardian")).resolves.toBe(false);
  });

  test("getRoleMembers decodes populated role members", async () => {
    serverMock.simulateTransaction.mockResolvedValueOnce({
      result: {
        retval: xdr.ScVal.scvVec([
          xdr.ScVal.scvString(TEST_SOURCE),
          xdr.ScVal.scvString("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANHUF"),
        ]),
      },
    });

    await expect(getRoleMembers("owner")).resolves.toEqual([
      TEST_SOURCE,
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANHUF",
    ]);
  });

  test("getRoleMembers returns an empty list for roles with no members", async () => {
    serverMock.simulateTransaction.mockResolvedValueOnce({
      result: { retval: xdr.ScVal.scvVec([]) },
    });

    await expect(getRoleMembers("manager")).resolves.toEqual([]);
  });
});
