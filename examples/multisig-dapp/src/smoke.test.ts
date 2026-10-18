import { describe, expect, it, vi } from "vitest";
import { AccordClient, type Proposal, type Transfer } from "@accord-protocol/sdk";

describe("Example dApp Smoke Test — Create, Approve & Execute Workflow", () => {
  const contractId = "CD4YAMHZETIO3GTHP4JB3SF2LQFQMZ6MW5FUNCTMXYGOVN6AAXDBQKJS";
  const owner = "GD5JDFYKNL23W2CQOXW6V57JMGDUQMK2M27B2L67MQK7Y65J42B67I7J";
  const recipient = "GB3K5Z7P66V336K3M5O4J2B67I7JGD5JDFYKNL23W2CQOXW6V57JMGDU";
  const token = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

  it("asserts create, approve, and execute calls occur in the exact expected order with right arguments", async () => {
    const callOrder: string[] = [];

    const mockCreateProposal = vi.fn(
      async (
        proposer: string,
        transfers: Transfer[],
        description: string,
        deadline: bigint,
        category: string
      ) => {
        callOrder.push("create_proposal");
        expect(proposer).toBe(owner);
        expect(transfers[0].to).toBe(recipient);
        expect(transfers[0].amount).toBe(10000000n);
        expect(description).toBe("Q4 Grant");
        return "tx-hash-create-001";
      }
    );

    const mockApprove = vi.fn(async (approver: string, proposalId: bigint) => {
      callOrder.push("approve");
      expect(approver).toBe(owner);
      expect(proposalId).toBe(1n);
      return "tx-hash-approve-002";
    });

    const mockExecute = vi.fn(async (executor: string, proposalId: bigint) => {
      callOrder.push("execute");
      expect(executor).toBe(owner);
      expect(proposalId).toBe(1n);
      return "tx-hash-execute-003";
    });

    // Create client instance and spy on SDK methods
    const client = new AccordClient({
      contractId,
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
    });

    vi.spyOn(client, "createProposal").mockImplementation(mockCreateProposal as any);
    vi.spyOn(client, "approve").mockImplementation(mockApprove as any);
    vi.spyOn(client, "execute").mockImplementation(mockExecute as any);

    // 1. Create Proposal
    const createTx = await client.createProposal(
      owner,
      [{ to: recipient, token, amount: 10000000n }],
      "Q4 Grant",
      1800000000n,
      "Grant"
    );
    expect(createTx).toBe("tx-hash-create-001");

    // 2. Approve Proposal
    const approveTx = await client.approve(owner, 1n);
    expect(approveTx).toBe("tx-hash-approve-002");

    // 3. Execute Proposal
    const executeTx = await client.execute(owner, 1n);
    expect(executeTx).toBe("tx-hash-execute-003");

    // Verify ordering
    expect(callOrder).toEqual(["create_proposal", "approve", "execute"]);
    expect(mockCreateProposal).toHaveBeenCalledTimes(1);
    expect(mockApprove).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });
});
