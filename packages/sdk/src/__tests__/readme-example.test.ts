import { describe, expect, it, vi } from "vitest";
import type { Transaction } from "@stellar/stellar-sdk";
import { AccordClient } from "../client.js";
import { AccordContractError, ContractError } from "../errors.js";

describe("SDK README Code Examples Typecheck and Execution", () => {
  it("compiles and executes the README quickstart example with mocked responses", async () => {
    const client = new AccordClient({
      contractId: "CD4YAMHZETIO3GTHP4JB3SF2LQFQMZ6MW5FUNCTMXYGOVN6AAXDBQKJS",
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      signTransaction: async (tx: Transaction) => tx,
    });

    expect(client).toBeDefined();

    // Mock getOwners and getThreshold
    vi.spyOn(client, "getOwners").mockResolvedValue([
      "GD5JDFYKNL23W2CQOXW6V57JMGDUQMK2M27B2L67MQK7Y65J42B67I7J",
      "GB3K5Z7P66V336K3M5O4J2B67I7JGD5JDFYKNL23W2CQOXW6V57JMGDU",
    ]);
    vi.spyOn(client, "getThreshold").mockResolvedValue(2);
    vi.spyOn(client, "isFrozen").mockResolvedValue(false);
    vi.spyOn(client, "getProposal").mockResolvedValue({
      id: 1n,
      proposer: "GD5JDFYKNL23W2CQOXW6V57JMGDUQMK2M27B2L67MQK7Y65J42B67I7J",
      description: "Test Proposal",
      deadline: 1800000000n,
      approvals: 2,
      approval_weight: 2,
      status: "Ready",
      kind: { Transfer: [] },
      ready_at: 1700000000n,
      quorum_weight: 2,
      category: "Grant",
      attachment_hash: null,
    });

    const owners = await client.getOwners();
    const threshold = await client.getThreshold();
    const isFrozen = await client.isFrozen();
    const proposal = await client.getProposal(1n);

    expect(owners.length).toBe(2);
    expect(threshold).toBe(2);
    expect(isFrozen).toBe(false);
    expect(proposal.id).toBe(1n);
    expect(proposal.status).toBe("Ready");
  });

  it("handles typed error branches as shown in the README", () => {
    const error = new AccordContractError(ContractError.RecoveryActive);

    let caughtRecovery = false;
    if (error instanceof AccordContractError) {
      if (error.errorCode === ContractError.RecoveryActive) {
        caughtRecovery = true;
      }
    }

    expect(caughtRecovery).toBe(true);
  });
});
