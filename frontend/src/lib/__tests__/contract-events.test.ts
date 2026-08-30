import { describe, test, expect, vi, beforeEach } from "vitest";
import { getLatestLedger, getContractEvents, mapProposal } from "../contract";
import { rpc } from "@stellar/stellar-sdk";

// Mock the rpc.Server instance directly through vi
vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: class {
        getLatestLedger = mockGetLatestLedger;
        getEvents = mockGetEvents;
      },
    },
  };
});


describe("Contract Events API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLatestLedger.mockResolvedValue({ sequence: 1000 });
    mockGetEvents.mockResolvedValue({ events: [], latestLedger: 1000 });
  });

  test("getLatestLedger throws on RPC error", async () => {
    mockGetLatestLedger.mockRejectedValueOnce(new Error("RPC failed"));
    await expect(getLatestLedger()).rejects.toThrow("RPC failed");
  });

  test("getContractEvents handles errors safely", async () => {
    mockGetEvents.mockRejectedValueOnce(new Error("RPC error"));
    const ledger = await getContractEvents(100);
    expect(ledger).toBe(100);
  });

  test("getProposalEvents parses standard proposal events (approved, executed, revoked)", async () => {
    mockGetEvents.mockResolvedValueOnce({
      events: [
        {
          topic: ["approved"],
          value: { id: 1, approver: "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4IQDNC" },
          ledger: 100,
          ledgerClosedAt: "2026-06-27T12:00:00Z",
        },
        {
          topic: ["executed"],
          value: { id: 1, executor: "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4IQDNC" },
          ledger: 105,
          ledgerClosedAt: "2026-06-27T13:00:00Z",
        },
      ],
      latestLedger: 105,
    });

    const events = await getProposalEvents(1);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "approved",
      actor: "GDHU6W...QDNC",
      ledger: 100,
    });
    expect(events[1]).toMatchObject({
      type: "executed",
      actor: "GDHU6W...QDNC",
      ledger: 105,
    });
  });

  test("getProposalEvents parses recurring payment events with labels and details", async () => {
    mockGetEvents.mockResolvedValueOnce({
      events: [
        {
          topic: ["recurring_payment_created"],
          value: {
            proposal_id: 1,
            schedule_id: 10,
            amount: 250000000n,
            token: "XLM",
            proposer: "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4IQDNC",
          },
          ledger: 101,
          ledgerClosedAt: "2026-06-27T12:10:00Z",
        },
        {
          topic: ["recurring_payment_disbursed"],
          value: {
            proposal_id: 1,
            schedule_id: 10,
            amount: 250000000n,
            token: "XLM",
            executor: "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4IQDNC",
          },
          ledger: 102,
          ledgerClosedAt: "2026-06-27T12:20:00Z",
        },
        {
          topic: ["recurring_payment_paused"],
          value: {
            proposal_id: 1,
            schedule_id: 10,
            actor: "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4IQDNC",
            reason: "Audit in progress",
          },
          ledger: 103,
          ledgerClosedAt: "2026-06-27T12:30:00Z",
        },
        {
          topic: ["recurring_payment_cancelled"],
          value: {
            proposal_id: 1,
            schedule_id: 10,
            actor: "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4IQDNC",
            reason: "Terminated",
          },
          ledger: 104,
          ledgerClosedAt: "2026-06-27T12:40:00Z",
        },
      ],
      latestLedger: 105,
    });

    const events = await getProposalEvents(1);
    expect(events).toHaveLength(4);

    expect(events[0]).toMatchObject({
      type: "recurring_payment_created",
      scheduleId: 10,
      amount: "25",
      token: "XLM",
      details: "Schedule #10 · 25 XLM",
      ledger: 101,
    });

    expect(events[1]).toMatchObject({
      type: "recurring_payment_disbursed",
      scheduleId: 10,
      amount: "25",
      token: "XLM",
      details: "Schedule #10 · 25 XLM",
      ledger: 102,
    });

    expect(events[2]).toMatchObject({
      type: "recurring_payment_paused",
      scheduleId: 10,
      details: "Schedule #10 · Audit in progress",
      ledger: 103,
    });

    expect(events[3]).toMatchObject({
      type: "recurring_payment_cancelled",
      scheduleId: 10,
      details: "Schedule #10 · Terminated",
      ledger: 104,
    });
  });

  test("getProposalEvents interleaves events in chronological order and filters out other proposals", async () => {
    mockGetEvents.mockResolvedValueOnce({
      events: [
        {
          topic: ["executed"],
          value: { id: 1, executor: "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4IQDNC" },
          ledger: 300,
        },
        {
          topic: ["recurring_payment_disbursed"],
          value: { proposal_id: 2, schedule_id: 99, amount: "100" },
          ledger: 250,
        },
        {
          topic: ["recurring_payment_created"],
          value: { proposal_id: 1, schedule_id: 1, amount: "50 XLM" },
          ledger: 150,
        },
        {
          topic: ["approved"],
          value: { id: 1, approver: "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4IQDNC" },
          ledger: 100,
        },
      ],
      latestLedger: 300,
    });

    const events = await getProposalEvents(1);
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe("approved");
    expect(events[0].ledger).toBe(100);
    expect(events[1].type).toBe("recurring_payment_created");
    expect(events[1].ledger).toBe(150);
    expect(events[2].type).toBe("executed");
    expect(events[2].ledger).toBe(300);
  });

  test("maps ChangeOwnerWeight proposal kind", () => {
    const proposal = mapProposal(
      {
        id: 7,
        proposer: "GPROPOSER1",
        description: "Adjust owner weight",
        deadline: 1782259200,
        approvals: 1,
        status: { Pending: undefined },
        kind: { ChangeOwnerWeight: ["GOWNER1111", 25] },
      },
      2,
    );

    expect(proposal.kind).toBe("change_owner_weight");
    expect(proposal.to).toBe("GOWNER...1111");
    expect(proposal.amount).toBe("25");
    expect(proposal.token).toBe("Owner weight");
  });
});

