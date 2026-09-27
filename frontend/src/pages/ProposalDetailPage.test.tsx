import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, test, vi } from "vitest";
import type { Proposal, ProposalEvent } from "../types/accord";
import { ProposalDetailPage } from "./ProposalDetailPage";
import * as contract from "../lib/contract";

vi.mock("../lib/contract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/contract")>();
  return {
    ...actual,
    getProposalEvents: vi.fn().mockResolvedValue([]),
    getOwners: vi.fn().mockResolvedValue(["GAPPROVER1"]),
    getRequiredQuorumWeight: vi.fn().mockResolvedValue(2),
  };
});

const baseProposal = (overrides: Partial<Proposal> = {}): Proposal => ({
  id: 1,
  kind: "transfer",
  category: "transfer",
  to: "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4IQDNC",
  amount: "25",
  token: "XLM",
  description: "Treasury payment",
  approvals: 1,
  threshold: 2,
  quorumWeight: 10,
  approvalWeight: 5,
  totalWeight: 20,
  status: "pending",
  deadline: "Jul 4, 2026",
  deadlineTs: 1783123200,
  createdAt: "Jun 27, 2026",
  proposer: "GPROPOSERADDRESS",
  userHasApproved: false,
  approverAddresses: ["GAPPROVER1"],
  ...overrides,
});

function renderDetail({
  route = "/proposals/1",
  proposals = [baseProposal()],
  walletAddress = "GCONNECTED123",
  onApprove = vi.fn(),
  onExecute = vi.fn(),
}: {
  route?: string;
  proposals?: Proposal[];
  walletAddress?: string | null;
  onApprove?: (id: number) => void;
  onExecute?: (id: number) => void;
} = {}) {
  render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route
          path="/proposals/:id"
          element={
            <ProposalDetailPage
              proposals={proposals}
              walletAddress={walletAddress}
              onApprove={onApprove}
              onExecute={onExecute}
            />
          }
        />
      </Routes>
    </MemoryRouter>
  );

  return { onApprove, onExecute };
}

describe("ProposalDetailPage", () => {
  test("displays all proposal fields for the URL id", () => {
    renderDetail();

    expect(screen.getByText("Proposal #1")).toBeTruthy();
    expect(screen.getByText("25 XLM")).toBeTruthy();
    expect(screen.getByText("GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4IQDNC")).toBeTruthy();
    expect(screen.getByText("Treasury payment")).toBeTruthy();
    expect(screen.getByText("Jul 4, 2026")).toBeTruthy();
    expect(screen.getByText("Jun 27, 2026")).toBeTruthy();
    expect(screen.getByText("1 / 2")).toBeTruthy();
    expect(screen.getAllByText("pending").length).toBeGreaterThan(0);
  });

  test("shows not found for a missing proposal id", () => {
    renderDetail({ route: "/proposals/9999" });

    expect(screen.getByText("Proposal not found")).toBeTruthy();
  });

  test("approves a pending proposal", () => {
    const { onApprove } = renderDetail();

    fireEvent.click(screen.getByRole("button", { name: /approve proposal/i }));

    expect(onApprove).toHaveBeenCalledWith(1);
  });

  test("executes a ready proposal after confirmation", () => {
    const { onExecute } = renderDetail({
      proposals: [baseProposal({ status: "ready", approvals: 2 })],
    });

    fireEvent.click(screen.getByRole("button", { name: /execute proposal/i }));
    fireEvent.click(screen.getByText("Confirm"));

    expect(onExecute).toHaveBeenCalledWith(1);
  });

  test("renders recurring-payment lifecycle events in activity timeline with details and order", async () => {
    const mockEvents: ProposalEvent[] = [
      {
        type: "approved",
        actor: "GAPPRO...VER1",
        timestamp: "Ledger #100",
        ledger: 100,
      },
      {
        type: "recurring_payment_created",
        actor: "GPROPO...SER1",
        timestamp: "Ledger #101",
        scheduleId: 5,
        amount: "50",
        token: "XLM",
        details: "Schedule #5 · 50 XLM",
        ledger: 101,
      },
      {
        type: "recurring_payment_disbursed",
        actor: "GEXECU...TOR1",
        timestamp: "Ledger #102",
        scheduleId: 5,
        amount: "50",
        token: "XLM",
        details: "Schedule #5 · 50 XLM",
        ledger: 102,
      },
      {
        type: "recurring_payment_paused",
        actor: "GADMIN...IST1",
        timestamp: "Ledger #103",
        scheduleId: 5,
        details: "Schedule #5 · Paused by admin",
        ledger: 103,
      },
      {
        type: "recurring_payment_cancelled",
        actor: "GADMIN...IST1",
        timestamp: "Ledger #104",
        scheduleId: 5,
        details: "Schedule #5 · Cancelled",
        ledger: 104,
      },
    ];

    vi.mocked(contract.getProposalEvents).mockResolvedValueOnce(mockEvents);

    renderDetail();

    await waitFor(() => {
      expect(screen.getByText("Approved")).toBeTruthy();
      expect(screen.getByText("Recurring Payment Created")).toBeTruthy();
      expect(screen.getByText("Recurring Payment Disbursed")).toBeTruthy();
      expect(screen.getByText("Recurring Payment Paused")).toBeTruthy();
      expect(screen.getByText("Recurring Payment Cancelled")).toBeTruthy();
    });

    expect(screen.getAllByText("Schedule #5 · 50 XLM")).toHaveLength(2);
    expect(screen.getByText("Schedule #5 · Paused by admin")).toBeTruthy();
    expect(screen.getByText("Schedule #5 · Cancelled")).toBeTruthy();
    expect(screen.getByText("GAPPRO...VER1")).toBeTruthy();
    expect(screen.getByText("GPROPO...SER1")).toBeTruthy();
  });
});

