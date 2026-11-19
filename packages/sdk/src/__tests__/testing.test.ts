import { describe, expect, it } from "vitest";
import { AccordContractError, AccordValidationError, ContractError } from "../errors.js";
import { EventSubscription } from "../events.js";
import type { AccordParsedEvent } from "../events.js";
import {
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  MockAccordContract,
  createMockRpcHandler,
} from "../testing.js";
import type { CreateRecurringParams } from "../types.js";

const alice = "GALICE";
const bob = "GBOB";
const carol = "GCAROL";
const token = "CTOKEN";
const NOW = 1_700_000_000n;
const deadline = NOW + 86_400n;
const transfers = [{ to: carol, token, amount: 500n }];

function contract(overrides: Partial<ConstructorParameters<typeof MockAccordContract>[0]> = {}) {
  return new MockAccordContract({
    owners: [{ address: alice, weight: 2 }, bob, carol],
    threshold: 3,
    now: NOW,
    ...overrides,
  });
}

async function expectCode(promise: Promise<unknown>, code: ContractError) {
  await expect(promise).rejects.toBeInstanceOf(AccordContractError);
  await promise.catch((err: AccordContractError) => expect(err.errorCode).toBe(code));
}

describe("MockAccordContract", () => {
  describe("configuration", () => {
    it("rejects empty owners, duplicate owners, bad weights and bad thresholds", () => {
      expect(() => new MockAccordContract({ owners: [], threshold: 1 })).toThrow(AccordValidationError);
      expect(() => new MockAccordContract({ owners: [alice, alice], threshold: 1 })).toThrow(/Duplicate owner/);
      expect(() => new MockAccordContract({ owners: [{ address: alice, weight: 0 }], threshold: 1 })).toThrow(
        AccordValidationError
      );
      expect(() => new MockAccordContract({ owners: [alice], threshold: 2 })).toThrow(AccordValidationError);
    });

    it("reports owners, weights and threshold", async () => {
      const c = contract();
      expect(await c.getOwners()).toEqual([alice, bob, carol]);
      expect(await c.getTotalWeight()).toBe(4);
      expect(await c.getOwnerWeight(alice)).toBe(2);
      expect(await c.getThreshold()).toBe(3);
      expect(await c.isOwner("GSTRANGER")).toBe(false);
      await expectCode(c.getOwnerWeight("GSTRANGER"), ContractError.OwnerNotFound);
    });
  });

  describe("proposal lifecycle", () => {
    it("runs create → weighted approve → execute deterministically", async () => {
      const c = contract();
      const created = await c.createProposal(alice, transfers, "Pay Carol", deadline);
      expect(created).toBe("1".padStart(64, "0"));
      expect(await c.getTotalProposals()).toBe(1n);

      await c.approve(alice, 1n);
      expect((await c.getProposal(1n)).status).toBe("Pending");
      expect(await c.getProposalApprovalProgress(1n)).toEqual({ approval_weight: 2, quorum_weight: 3, total_weight: 4 });

      await c.approve(bob, 1n);
      const ready = await c.getProposal(1n);
      expect(ready.status).toBe("Ready");
      expect(ready.ready_at).toBe(NOW);
      expect(await c.getApprovers(1n)).toEqual([alice, bob]);

      await c.execute(carol, 1n);
      expect((await c.getProposal(1n)).status).toBe("Executed");
      expect(c.events.map((e) => e.type)).toEqual([
        "proposal_created",
        "proposal_approved",
        "proposal_approved",
        "proposal_executed",
      ]);
    });

    it("drops back to Pending when an approval is revoked", async () => {
      const c = contract();
      await c.createProposal(alice, transfers, "Pay Carol", deadline);
      await c.approve(alice, 1);
      await c.approve(bob, 1);
      await c.revoke(bob, 1);
      expect(await c.hasApproved(1, bob)).toBe(false);
      expect((await c.getProposal(1)).status).toBe("Pending");
    });

    it("pages proposals with the contract's 20-item cap", async () => {
      const c = contract();
      for (let i = 0; i < 25; i++) await c.createProposal(alice, transfers, `P${i}`, deadline);
      expect(await c.getProposalsPaged(0, 50)).toHaveLength(20);
      expect((await c.getProposalsPaged(20)).map((p) => p.id)).toEqual([21n, 22n, 23n, 24n, 25n]);
      expect(await c.getProposalsPaged(25)).toEqual([]);
    });

    it("activates a recurring schedule when its proposal executes", async () => {
      const c = contract({ threshold: 1 });
      const schedule: CreateRecurringParams = {
        recipient: carol,
        token,
        amount: 100n,
        interval_secs: 3600n,
        start_time: NOW,
        end_time: 0n,
        cliff_time: 0n,
        total_cap: 0n,
        kind: "FixedAmountPerPeriod",
      };
      await c.createRecurringProposal(alice, schedule, "Payroll", deadline, "Payroll");
      await c.approve(bob, 1);
      await c.execute(bob, 1);
      expect(await c.getActiveRecurringCount()).toBe(1);
      expect((await c.getRecurringPayment(1)).recipient).toBe(carol);
      await expectCode(c.getRecurringPayment(2), ContractError.RecurringPaymentNotFound);
    });
  });

  describe("contract errors", () => {
    it("rejects invalid proposals with the contract's codes", async () => {
      const c = contract();
      await expectCode(c.createProposal("GSTRANGER", transfers, "x", deadline), ContractError.Unauthorized);
      await expectCode(c.createProposal(alice, transfers, "  ", deadline), ContractError.EmptyDescription);
      await expectCode(c.createProposal(alice, transfers, "x".repeat(301), deadline), ContractError.DescriptionTooLong);
      await expectCode(c.createProposal(alice, transfers, "x", NOW), ContractError.InvalidDeadline);
      await expectCode(c.createProposal(alice, [], "x", deadline), ContractError.InvalidAmount);
      await expectCode(c.getProposal(7), ContractError.ProposalNotFound);
    });

    it("enforces approval and execution rules", async () => {
      const c = contract({ timeLockDelay: 600n });
      await c.createProposal(alice, transfers, "Pay Carol", deadline);
      await expectCode(c.execute(alice, 1), ContractError.ThresholdNotMet);
      await expectCode(c.revoke(bob, 1), ContractError.NotApproved);

      await c.approve(alice, 1);
      await expectCode(c.approve(alice, 1), ContractError.AlreadyApproved);
      await c.approve(bob, 1);
      await expectCode(c.execute(alice, 1), ContractError.TimeLockActive);

      c.setFrozen(true);
      await expectCode(c.execute(alice, 1), ContractError.ContractFrozen);
      c.setFrozen(false).advanceTime(600);
      await c.execute(alice, 1);
      await expectCode(c.approve(carol, 1), ContractError.ProposalNotActive);
    });

    it("expires proposals once the clock passes the deadline", async () => {
      const c = contract();
      await c.createProposal(alice, transfers, "Pay Carol", deadline);
      c.advanceTime(86_401);
      expect((await c.getProposal(1)).status).toBe("Expired");
      await expectCode(c.execute(alice, 1), ContractError.ProposalExpired);
      expect(() => c.advanceTime(-1)).toThrow(AccordValidationError);
    });

    it("injects scripted failures once", async () => {
      const c = contract();
      c.failNext("createProposal", new Error("rpc down"));
      await expect(c.createProposal(alice, transfers, "x", deadline)).rejects.toThrow("rpc down");
      // A failed call records no transaction, so the next hash is still the first.
      await expect(c.createProposal(alice, transfers, "x", deadline)).resolves.toMatch(/^0+1$/);
    });
  });

  describe("event stream", () => {
    it("resumes from a cursor and drives EventSubscription", async () => {
      const c = contract();
      await c.createProposal(alice, transfers, "Pay Carol", deadline);
      await c.approve(alice, 1);

      const first = await c.fetchEvents(null);
      expect(first).toHaveLength(2);
      expect(first[0].id).toBe(`${"1".padStart(64, "0")}:2:0`);
      expect(first[0].data).toMatchObject({ version: 2, id: 1n, proposer: alice });

      await c.approve(bob, 1);
      expect((await c.fetchEvents(first[1].id)).map((e) => e.type)).toEqual(["proposal_approved"]);

      const seen: AccordParsedEvent[] = [];
      const sub = new EventSubscription({ types: ["proposal_approved"] });
      sub.on("*", (e) => seen.push(e));
      sub.processEvents(await c.fetchEvents(null));
      expect(seen).toHaveLength(2);
    });
  });
});

describe("createMockRpcHandler", () => {
  it("serves health, latest ledger and paged events", async () => {
    const c = contract();
    const rpc = createMockRpcHandler(c);
    await c.createProposal(alice, transfers, "Pay Carol", deadline);
    await c.approve(alice, 1);

    expect(await rpc({ jsonrpc: "2.0", id: 1, method: "getHealth" })).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { status: "healthy", latestLedger: 3 },
    });
    expect(await rpc({ jsonrpc: "2.0", id: 2, method: "getLatestLedger" })).toMatchObject({ result: { sequence: 3 } });

    const page = (await rpc({ jsonrpc: "2.0", id: 3, method: "getEvents", params: { limit: 1 } })) as {
      result: { events: { data: { id: string } }[]; cursor: string };
    };
    expect(page.result.events).toHaveLength(1);
    expect(page.result.events[0].data.id).toBe("1");

    const rest = (await rpc({ jsonrpc: "2.0", id: 4, method: "getEvents", params: { cursor: page.result.cursor } })) as {
      result: { events: { type: string }[] };
    };
    expect(rest.result.events.map((e) => e.type)).toEqual(["proposal_approved"]);
  });

  it("returns JSON-RPC errors for bad requests", async () => {
    const rpc = createMockRpcHandler(contract());
    expect(await rpc({ jsonrpc: "1.0", id: 1, method: "getHealth" } as never)).toMatchObject({
      error: { code: JSON_RPC_INVALID_REQUEST },
    });
    expect(await rpc({ jsonrpc: "2.0", id: 2, method: "sendTransaction" })).toMatchObject({
      error: { code: JSON_RPC_METHOD_NOT_FOUND },
    });
    expect(await rpc({ jsonrpc: "2.0", id: 3, method: "getEvents", params: { limit: 0 } })).toMatchObject({
      error: { code: JSON_RPC_INVALID_PARAMS },
    });
  });
});
