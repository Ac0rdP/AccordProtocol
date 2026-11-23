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

describe("SDK README developer-tooling examples", () => {
  it("runs the code generation example", async () => {
    const { readFileSync } = await import("node:fs");
    const { generateClient, parseSorobanSpec } = await import("../index.js");
    const abi = parseSorobanSpec(readFileSync(new URL("./fixtures/accord-spec.json", import.meta.url), "utf8"));

    const python = generateClient(abi, { language: "python" });
    const go = generateClient(abi, { language: "go", clientName: "Treasury", packageName: "treasury" });

    expect(python.fileName).toBe("accord_contract_client.py");
    expect(go.fileName).toBe("treasury.go");
  });

  it("runs the bundle budget example", async () => {
    const { evaluateBudgets, formatBudgetReport, validateBudgets } = await import("../index.js");
    const budgets = validateBudgets([
      { name: "errors", exports: ["parseContractError"], maxGzipBytes: "3 KB", forbiddenImports: ["@stellar/stellar-sdk"] },
    ]);
    const report = evaluateBudgets(budgets, [
      { name: "errors", bytes: 7600, gzipBytes: 2500, modules: ["dist/esm/errors.js"] },
    ]);
    expect(formatBudgetReport(report)).toContain("PASS  errors");
  });

  it("runs the release planning example", async () => {
    const { planRelease } = await import("../index.js");
    const plan = planRelease("0.1.0", ["feat(sdk): add codegen", "fix: handle empty spec", "docs: typo"]);
    expect(plan?.nextVersion).toBe("0.2.0");
    expect(plan?.tag).toBe("sdk-v0.2.0");
  });
});

describe("SDK README cookbook, testing, ABI and migration examples", () => {
  it("runs the cookbook example", async () => {
    const {
      MockAccordContract,
      approveUntilQuorum,
      collectTreasuryAnalytics,
      executeWhenReady,
      proposeRecurringPayment,
      runTransferLifecycle,
    } = await import("../index.js");

    const [alice, bob, carol] = ["GALICE", "GBOB", "GCAROL"];
    const now = 1_700_000_000n;
    const client = new MockAccordContract({ owners: [alice, bob, carol], threshold: 2, now });

    const { proposal, executeTxHash } = await runTransferLifecycle(client, {
      proposer: alice,
      approvers: [alice, bob, carol],
      executor: bob,
      transfers: [{ to: carol, token: "CUSDC", amount: 250_0000000n }],
      description: "Design retainer",
      deadline: now + 86_400n,
      now,
    });
    expect(proposal.proposalId).toBe(1n);
    expect(executeTxHash).toBeDefined();

    const payroll = await proposeRecurringPayment(client, {
      proposer: alice,
      schedule: {
        recipient: carol, token: "CUSDC", amount: 1_000n, interval_secs: 2_592_000n,
        start_time: now, end_time: 0n, cliff_time: 0n, total_cap: 12_000n, kind: "FixedAmountPerPeriod",
      },
      description: "Monthly payroll",
      deadline: now + 86_400n,
    });
    await approveUntilQuorum(client, payroll.proposalId, [alice, bob]);
    await executeWhenReady(client, bob, payroll.proposalId, { now });

    const analytics = await collectTreasuryAnalytics(client);
    expect(analytics.activeRecurring).toBe(1);
    expect(analytics.proposals.executedByToken).toEqual({ CUSDC: 2500000000n });
  });

  it("runs the testing harness example", async () => {
    const { ContractError, MockAccordContract, createMockRpcHandler, subscribeEvents } = await import("../index.js");

    const mock = new MockAccordContract({
      owners: [{ address: "GALICE", weight: 2 }, "GBOB"],
      threshold: 2,
      timeLockDelay: 3_600n,
      now: 1_700_000_000n,
    });

    await mock.createProposal("GALICE", [{ to: "GBOB", token: "CUSDC", amount: 5n }], "Refund", 1_700_086_400n);
    await mock.approve("GALICE", 1n);
    const locked = await mock.execute("GBOB", 1n).catch((e) => e.errorCode === ContractError.TimeLockActive);
    expect(locked).toBe(true);
    mock.advanceTime(3_600);
    await mock.execute("GBOB", 1n);

    mock.failNext("approve", new Error("RPC unavailable"));
    mock.setFrozen(true);
    expect(await mock.isFrozen()).toBe(true);

    const sub = subscribeEvents((cursor) => mock.fetchEvents(cursor), { pollIntervalMs: 10 });
    const rpc = createMockRpcHandler(mock);
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "getEvents", params: { cursor: null, limit: 50 } });
    sub.stop();
    expect(res).toMatchObject({ result: { events: expect.any(Array) } });
  });

  it("runs the versioned ABI example", async () => {
    const { readFileSync } = await import("node:fs");
    const { createVersionedAbi, diffAbi, parseSorobanSpec, parseVersionedAbi, serializeVersionedAbi, versionedAbiFileName } =
      await import("../index.js");

    const abi = parseSorobanSpec(readFileSync(new URL("./fixtures/accord-spec.json", import.meta.url), "utf8"));
    const artifact = createVersionedAbi(abi, { contractVersion: 1, eventSchemaVersion: 2, storageSchemaVersion: 1 });
    expect(versionedAbiFileName(artifact)).toBe("accord-abi.v1.json");

    const published = parseVersionedAbi(serializeVersionedAbi(artifact));
    const { breaking, removedFunctions } = diffAbi(published, abi);
    expect(breaking).toBe(false);
    expect(removedFunctions).toEqual([]);
  });

  it("runs the migration example and keeps MIGRATION.md in sync", async () => {
    const { readFileSync } = await import("node:fs");
    const { checkCompatibility, readContractSurface, renderMigrationGuide, runCodemods } = await import("../index.js");

    const client = {
      getVersion: async () => 1,
      getStorageVersion: async () => 1,
      getRoleVersion: async () => 0,
      isGovernanceMigrated: async () => true,
    };
    const report = checkCompatibility(await readContractSurface(client));
    expect(report).toMatchObject({ compatible: false, requiredMigrations: ["migrate_to_rbac"] });

    const { output } = runCodemods("if (proposal.approvals >= threshold && err.errorCode === 56) {}");
    expect(output).toBe(
      "if (proposal.approval_weight >= proposal.quorum_weight && err.errorCode === ContractError.DeprecatedEntrypoint) {}"
    );

    const doc = readFileSync(new URL("../../MIGRATION.md", import.meta.url), "utf8");
    expect(doc).toBe(renderMigrationGuide());
  });
});
