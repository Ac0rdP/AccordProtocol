import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  Account,
  Keypair,
  rpc,
  Transaction,
  xdr,
} from "@stellar/stellar-sdk";
import { AccordClient } from "../client.js";
import { AccordContractError, AccordValidationError, ContractError } from "../errors.js";
import {
  addressToScVal,
  boolToScVal,
  i128ToScVal,
  scValToProposal,
  u32ToScVal,
  u64ToScVal,
} from "../conversion.js";
import type { Transfer } from "../types.js";

describe("AccordClient Unit Tests (Mocked RPC)", () => {
  const contractId = "CD4YAMHZETIO3GTHP4JB3SF2LQFQMZ6MW5FUNCTMXYGOVN6AAXDBQKJS";
  const owner1 = "GD5JDFYKNL23W2CQOXW6V57JMGDUQMK2M27B2L67MQK7Y65J42B67I7J";
  const owner2 = "GB3K5Z7P66V336K3M5O4J2B67I7JGD5JDFYKNL23W2CQOXW6V57JMGDU";
  const token = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
  const networkPassphrase = "Test SDF Network ; September 2015";
  const rpcUrl = "https://soroban-testnet.stellar.org";

  let client: AccordClient;
  let mockSignTransaction: any;

  beforeEach(() => {
    mockSignTransaction = vi.fn((tx: Transaction) => tx);
    client = new AccordClient({
      contractId,
      rpcUrl,
      networkPassphrase,
      signTransaction: mockSignTransaction,
      sourceAccount: owner1,
    });
  });

  describe("Constructor & Address Validation", () => {
    it("instantiates successfully with valid configuration", () => {
      expect(client.contractId).toBe(contractId);
      expect(client.rpcUrl).toBe(rpcUrl);
      expect(client.networkPassphrase).toBe(networkPassphrase);
    });

    it("throws AccordValidationError on invalid contractId", () => {
      expect(
        () =>
          new AccordClient({
            contractId: "invalid-id",
            rpcUrl,
            networkPassphrase,
          })
      ).toThrow(AccordValidationError);
    });

    it("throws AccordValidationError before network call if caller address is invalid", async () => {
      await expect(
        client.approve("invalid-owner", 1n)
      ).rejects.toThrow(AccordValidationError);
    });
  });

  describe("Simulation-based Reads", () => {
    it("getThreshold queries contract and parses u32 return value", async () => {
      vi.spyOn(client.server, "simulateTransaction").mockResolvedValueOnce({
        id: "1",
        events: [],
        transactionData: new xdr.SorobanTransactionData({
          ext: new xdr.ExtensionPoint(0),
          resources: new xdr.SorobanResources({
            footprint: new xdr.LedgerFootprint({ readOnly: [], readWrite: [] }),
            instructions: 100,
            readBytes: 100,
            writeBytes: 100,
          }),
          refundableFee: xdr.Int64.fromString("100"),
        }),
        minResourceFee: "100",
        result: {
          auth: [],
          retval: u32ToScVal(2),
        },
        latestLedger: 1000,
      } as any);

      const threshold = await client.getThreshold();
      expect(threshold).toBe(2);
    });

    it("getOwners queries contract and returns list of addresses", async () => {
      vi.spyOn(client.server, "simulateTransaction").mockResolvedValueOnce({
        id: "1",
        events: [],
        transactionData: new xdr.SorobanTransactionData({
          ext: new xdr.ExtensionPoint(0),
          resources: new xdr.SorobanResources({
            footprint: new xdr.LedgerFootprint({ readOnly: [], readWrite: [] }),
            instructions: 100,
            readBytes: 100,
            writeBytes: 100,
          }),
          refundableFee: xdr.Int64.fromString("100"),
        }),
        minResourceFee: "100",
        result: {
          auth: [],
          retval: xdr.ScVal.scvVec([addressToScVal(owner1), addressToScVal(owner2)]),
        },
        latestLedger: 1000,
      } as any);

      const owners = await client.getOwners();
      expect(owners).toEqual([owner1, owner2]);
    });

    it("isFrozen returns boolean state", async () => {
      vi.spyOn(client.server, "simulateTransaction").mockResolvedValueOnce({
        id: "1",
        events: [],
        transactionData: new xdr.SorobanTransactionData({
          ext: new xdr.ExtensionPoint(0),
          resources: new xdr.SorobanResources({
            footprint: new xdr.LedgerFootprint({ readOnly: [], readWrite: [] }),
            instructions: 100,
            readBytes: 100,
            writeBytes: 100,
          }),
          refundableFee: xdr.Int64.fromString("100"),
        }),
        minResourceFee: "100",
        result: {
          auth: [],
          retval: boolToScVal(false),
        },
        latestLedger: 1000,
      } as any);

      const frozen = await client.isFrozen();
      expect(frozen).toBe(false);
    });
  });

  describe("State-changing Write Invocations & Signing Callback", () => {
    it("createProposal simulates, prepares, calls signTransaction, and submits", async () => {
      // Mock getAccount
      vi.spyOn(client.server, "getAccount").mockResolvedValue(
        new Account(owner1, "100")
      );

      // Mock simulateTransaction success
      vi.spyOn(client.server, "simulateTransaction").mockResolvedValue({
        id: "1",
        events: [],
        transactionData: new xdr.SorobanTransactionData({
          ext: new xdr.ExtensionPoint(0),
          resources: new xdr.SorobanResources({
            footprint: new xdr.LedgerFootprint({ readOnly: [], readWrite: [] }),
            instructions: 200,
            readBytes: 200,
            writeBytes: 200,
          }),
          refundableFee: xdr.Int64.fromString("100"),
        }),
        minResourceFee: "100",
        result: {
          auth: [],
          retval: u64ToScVal(1n),
        },
        latestLedger: 1000,
      } as any);

      // Mock sendTransaction
      vi.spyOn(client.server, "sendTransaction").mockResolvedValue({
        status: "PENDING",
        hash: "mock-tx-hash-12345",
        latestLedger: 1000,
        latestLedgerCloseTime: 1700000000,
      } as any);

      const transfers: Transfer[] = [
        { to: owner2, token, amount: 5000000n },
      ];

      const txHash = await client.createProposal(
        owner1,
        transfers,
        "Proposal description",
        1800000000n,
        "Transfer"
      );

      expect(txHash).toBe("mock-tx-hash-12345");
      expect(mockSignTransaction).toHaveBeenCalledTimes(1);
    });

    it("throws AccordContractError when simulation encounters on-chain contract error", async () => {
      vi.spyOn(client.server, "getAccount").mockResolvedValue(
        new Account(owner1, "100")
      );

      // Mock simulation returning contract error ContractFrozen (#26)
      vi.spyOn(client.server, "simulateTransaction").mockResolvedValue({
        id: "1",
        events: [],
        error: "Transaction simulation failed: HostError: Error(Contract, #26)",
        latestLedger: 1000,
      } as any);

      await expect(
        client.approve(owner1, 1n)
      ).rejects.toThrow(AccordContractError);

      try {
        await client.approve(owner1, 1n);
      } catch (e: any) {
        expect(e.errorCode).toBe(ContractError.ContractFrozen);
        expect(e.codeName).toBe("ContractFrozen");
      }
    });
  });
});
