import { describe, expect, it } from "vitest";
import { useOwners, useProposal, useProposalActions, useProposals } from "../react.js";

describe("React SDK hooks", () => {
  const mockClient = {
    getOwners: async () => ["GA1", "GA2"],
    getProposal: async (id: number) => ({
      id,
      kind: "transfer",
      to: "GB1",
      amount: "100",
      token: "XLM",
      description: "Test",
      approvals: 1,
      threshold: 2,
      status: "pending" as const,
      deadline: 1800000000,
      createdAt: 1700000000,
      proposer: "GA1",
      userHasApproved: true,
      approverAddresses: ["GA1"],
      category: "Ops",
    }),
    getProposals: async () => [],
    approveProposal: async (id: number) => true,
    executeProposal: async (id: number) => true,
  };

  it("useOwners refetches owner addresses", async () => {
    const hook = useOwners(mockClient);
    expect(hook.loading).toBe(true);
    const owners = await hook.refetch();
    expect(owners).toEqual(["GA1", "GA2"]);
  });

  it("useProposal refetches a proposal by ID", async () => {
    const hook = useProposal(mockClient, 5);
    const proposal = await hook.refetch();
    expect(proposal?.id).toBe(5);
  });

  it("useProposals queries proposal list", async () => {
    const hook = useProposals(mockClient);
    const proposals = await hook.refetch();
    expect(proposals).toEqual([]);
  });

  it("useProposalActions executes approve and execute methods", async () => {
    const actions = useProposalActions(mockClient);
    await expect(actions.approve(1)).resolves.toBe(true);
    await expect(actions.execute(1)).resolves.toBe(true);
  });
});
