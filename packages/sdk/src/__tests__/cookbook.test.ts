import { describe, expect, it } from "vitest";
import {
  approveUntilQuorum,
  collectTreasuryAnalytics,
  executeWhenReady,
  proposeRecurringPayment,
  proposeTransfer,
  runTransferLifecycle,
  summarizeProposals,
  validateRecurringParams,
} from "../cookbook.js";
import { AccordContractError, AccordValidationError, ContractError } from "../errors.js";
import { MockAccordContract } from "../testing.js";
import type { CreateRecurringParams, Proposal } from "../types.js";

const alice = "GALICE";
const bob = "GBOB";
const carol = "GCAROL";
const usdc = "CUSDC";
const xlm = "CXLM";
const NOW = 1_700_000_000n;
const deadline = NOW + 86_400n;

function treasury(timeLockDelay = 0n) {
  return new MockAccordContract({ owners: [alice, bob, carol], threshold: 2, now: NOW, timeLockDelay });
}

const schedule: CreateRecurringParams = {
  recipient: carol,
  token: usdc,
  amount: 1_000n,
  interval_secs: 2_592_000n,
  start_time: NOW,
  end_time: 0n,
  cliff_time: 0n,
  total_cap: 12_000n,
  kind: "FixedAmountPerPeriod",
};

describe("cookbook: create / approve / execute", () => {
  it("proposes a transfer and returns its id", async () => {
    const client = treasury();
    const receipt = await proposeTransfer(client, {
      proposer: alice,
      transfers: [{ to: carol, token: usdc, amount: 250n }],
      description: "Design retainer",
      deadline,
    });
    expect(receipt.proposalId).toBe(1n);
    expect(receipt.txHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a proposal with no transfers before calling the contract", async () => {
    const client = treasury();
    await expect(
      proposeTransfer(client, { proposer: alice, transfers: [], description: "x", deadline })
    ).rejects.toBeInstanceOf(AccordValidationError);
    expect(await client.getTotalProposals()).toBe(0n);
  });

  it("approves until quorum, skipping signers who already approved or are not needed", async () => {
    const client = treasury();
    await client.createProposal(alice, [{ to: carol, token: usdc, amount: 1n }], "x", deadline);
    await client.approve(alice, 1);

    const outcome = await approveUntilQuorum(client, 1n, [alice, bob, carol]);
    expect(outcome.approved.map((a) => a.approver)).toEqual([bob]);
    expect(outcome.skipped).toEqual([
      { approver: alice, reason: "already-approved" },
      { approver: carol, reason: "quorum-reached" },
    ]);
    expect(outcome.quorumReached).toBe(true);
    await expect(approveUntilQuorum(client, 1n, [])).rejects.toBeInstanceOf(AccordValidationError);
  });

  it("refuses to execute a proposal that is not Ready or still time-locked", async () => {
    const client = treasury(3_600n);
    await client.createProposal(alice, [{ to: carol, token: usdc, amount: 1n }], "x", deadline);
    await expect(executeWhenReady(client, alice, 1n, { now: NOW })).rejects.toThrow(/Pending, not Ready/);

    await approveUntilQuorum(client, 1n, [alice, bob]);
    await expect(executeWhenReady(client, alice, 1n, { now: NOW })).rejects.toThrow(/time-locked until 1700003600/);

    client.advanceTime(3_600);
    await expect(executeWhenReady(client, alice, 1n, { now: client.now })).resolves.toMatch(/^[0-9a-f]{64}$/);
    expect((await client.getProposal(1n)).status).toBe("Executed");
  });

  it("runs the whole lifecycle, and stops before execution when time-locked", async () => {
    const params = {
      proposer: alice,
      approvers: [alice, bob, carol],
      executor: bob,
      transfers: [{ to: carol, token: usdc, amount: 250n }],
      description: "Design retainer",
      deadline,
      now: NOW,
    };
    const done = await runTransferLifecycle(treasury(), params);
    expect(done.executeTxHash).toBeDefined();

    const locked = await runTransferLifecycle(treasury(60n), params);
    expect(locked.approvals.quorumReached).toBe(true);
    expect(locked.executeTxHash).toBeUndefined();
  });

  it("surfaces contract errors from the client unchanged", async () => {
    const client = treasury();
    await expect(
      proposeTransfer(client, {
        proposer: "GSTRANGER",
        transfers: [{ to: carol, token: usdc, amount: 1n }],
        description: "x",
        deadline,
      })
    ).rejects.toMatchObject({ errorCode: ContractError.Unauthorized });
    await expect(approveUntilQuorum(client, 9n, [alice])).rejects.toBeInstanceOf(AccordContractError);
  });
});

describe("cookbook: recurring payments", () => {
  it("validates schedules against the contract's bounds", () => {
    expect(() => validateRecurringParams(schedule)).not.toThrow();
    expect(() => validateRecurringParams({ ...schedule, amount: 0n })).toThrow(/params.amount/);
    expect(() => validateRecurringParams({ ...schedule, interval_secs: 59n })).toThrow(/params.interval_secs/);
    expect(() => validateRecurringParams({ ...schedule, total_cap: 999n })).toThrow(/params.total_cap/);
    expect(() => validateRecurringParams({ ...schedule, end_time: NOW })).toThrow(/params.end_time/);
    expect(() => validateRecurringParams({ ...schedule, cliff_time: NOW - 1n })).toThrow(/params.cliff_time/);
  });

  it("proposes payroll that becomes an active schedule after execution", async () => {
    const client = treasury();
    const { proposalId } = await proposeRecurringPayment(client, {
      proposer: alice,
      schedule,
      description: "Monthly payroll",
      deadline,
    });
    await approveUntilQuorum(client, proposalId, [alice, bob]);
    await executeWhenReady(client, bob, proposalId, { now: NOW });

    expect(await client.getActiveRecurringCount()).toBe(1);
    expect((await client.getProposal(proposalId)).category).toBe("Payroll");
  });
});

describe("cookbook: analytics", () => {
  const base: Omit<Proposal, "id" | "status" | "kind" | "category"> = {
    proposer: alice,
    description: "x",
    deadline,
    approvals: 0,
    approval_weight: 0,
    ready_at: 0n,
    quorum_weight: 2,
    attachment_hash: null,
  };

  it("summarizes proposals by status, category and token", () => {
    const summary = summarizeProposals([
      { ...base, id: 1n, status: "Executed", category: "Payroll", kind: { Transfer: [{ to: carol, token: usdc, amount: 10n }] } },
      { ...base, id: 2n, status: "Expired", category: "Grant", kind: { Transfer: [{ to: carol, token: usdc, amount: 5n }] } },
      { ...base, id: 3n, status: "Pending", category: "Ops", kind: { Transfer: [{ to: bob, token: xlm, amount: 7n }] } },
      { ...base, id: 4n, status: "Executed", category: "Ops", kind: { ChangeThreshold: 3 } },
    ]);
    expect(summary.total).toBe(4);
    expect(summary.byStatus).toEqual({ Executed: 2, Expired: 1, Pending: 1 });
    expect(summary.byCategory).toEqual({ Payroll: 1, Grant: 1, Ops: 2 });
    expect(summary.requestedByToken).toEqual({ [usdc]: 15n, [xlm]: 7n });
    expect(summary.executedByToken).toEqual({ [usdc]: 10n });
    expect(summary.executionRate).toBeCloseTo(2 / 3);
    expect(summarizeProposals([]).executionRate).toBe(0);
  });

  it("pages through every proposal when collecting treasury analytics", async () => {
    const client = treasury();
    for (let i = 0; i < 23; i++) {
      await client.createProposal(alice, [{ to: carol, token: usdc, amount: 1n }], `P${i}`, deadline);
    }
    const analytics = await collectTreasuryAnalytics(client);
    expect(analytics.proposals.total).toBe(23);
    expect(analytics.proposals.requestedByToken[usdc]).toBe(23n);
    expect(analytics).toMatchObject({ owners: [alice, bob, carol], threshold: 2, totalWeight: 3, activeRecurring: 0 });
  });
});
