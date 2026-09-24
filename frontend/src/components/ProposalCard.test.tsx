import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { vi, describe, test, expect, beforeEach } from "vitest";
import type { Proposal } from "../types/accord";
import { ProposalCard } from "./ProposalCard";

vi.mock("../hooks/useContract", () => ({
  useContract: () => ({
    proposals: [{ id: 1, status: "pending" }],
    owners: [],
    ownerAddresses: [],
    stats: [],
    loading: false,
    error: null,
    refresh: () => undefined,
  }),
}));

const baseProposal = (overrides: Partial<Proposal> = {}): Proposal => ({
  id: 42,
  kind: "transfer",
  to: "GABCDE...WXYZ",
  amount: "100",
  token: "USDC",
  description: "Test proposal",
  approvals: 1,
  threshold: 2,
  quorumWeight: 10,
  approvalWeight: 5,
  totalWeight: 20,
  status: "pending",
  deadline: "Jun 24, 2026",
  deadlineTs: 1782259200,
  createdAt: "proposal #42",
  proposer: "GPROPO...SER1",
  userHasApproved: false,
  approverAddresses: [],
  ...overrides,
});

function renderProposalCard({
  proposal = baseProposal(),
  walletAddress = "GCONNECTED123",
  onApprove = vi.fn(),
  onExecute = vi.fn(),
  onRevoke = vi.fn(),
}: {
  proposal?: Proposal;
  walletAddress?: string | null;
  onApprove?: (id: number) => void;
  onExecute?: (id: number) => void;
  onRevoke?: (id: number) => void;
} = {}) {
  return render(
    <MemoryRouter>
      <ProposalCard
        proposal={proposal}
        walletAddress={walletAddress}
        onApprove={onApprove}
        onExecute={onExecute}
        onRevoke={onRevoke}
      />
    </MemoryRouter>
  );
}

describe("ProposalCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  test("shows Approve for a pending proposal when wallet is connected", () => {
    renderProposalCard();

    expect(screen.getByText("Approve")).toBeTruthy();
  });

  test("shows Connect & Approve for a pending proposal without a wallet", () => {
    renderProposalCard({ walletAddress: null });

    expect(screen.getByText("Connect & Approve")).toBeTruthy();
  });

  test("shows Execute for a ready proposal and hides Approve", () => {
    renderProposalCard({ proposal: baseProposal({ status: "ready" }) });

    expect(screen.getByText("Execute")).toBeTruthy();
    expect(screen.queryByText("Approve")).toBeNull();
  });

  test.each(["executed", "expired"] as const)(
    "hides action buttons for %s proposals",
    (status) => {
      renderProposalCard({ proposal: baseProposal({ status }) });

      expect(screen.queryByText("Approve")).toBeNull();
      expect(screen.queryByText("Execute")).toBeNull();
      expect(screen.queryByText("Connect & Approve")).toBeNull();
    }
  );

  test("calls onApprove with the proposal id", async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();

    renderProposalCard({ onApprove });

    await user.click(screen.getByRole("button", { name: /approve proposal/i }));

    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith(42);
  });

  test("links to the proposal detail page", () => {
    renderProposalCard();

    expect(screen.getByRole("link", { name: "Send 100 USDC" })).toHaveAttribute(
      "href",
      "/proposals/42"
    );
    expect(screen.getByRole("link", { name: "View details" })).toHaveAttribute(
      "href",
      "/proposals/42"
    );
  });

  test("copies the direct proposal URL and shows temporary feedback", async () => {
    vi.useFakeTimers();

    renderProposalCard();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /copy proposal link/i }));
      await Promise.resolve();
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      `${window.location.origin}/proposals/42`
    );
    expect(
      screen.getByRole("button", { name: /proposal link copied/i })
    ).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(1500);
    });

    expect(
      screen.getByRole("button", { name: /copy proposal link/i })
    ).toBeTruthy();
    vi.useRealTimers();
  });

  test("renders change-owner-weight proposals with governance summary", () => {
    renderProposalCard({
      proposal: baseProposal({
        kind: "change_owner_weight",
        to: "GOWNER...R111",
        amount: "25",
        token: "Owner weight",
      }),
    });

    expect(screen.getByText("Change Weight")).toBeTruthy();
    expect(screen.getByText("Governance")).toBeTruthy();
    expect(screen.getByText("Owner GOWNER...R111")).toBeTruthy();
    expect(screen.getByText("New weight: 25")).toBeTruthy();
  });

  // ── Stale-weight / snapshotted quorum tests ────────────────────────────────
  //
  // A proposal's quorum is fixed at creation time (snapshotted in quorumWeight).
  // If owner weights change after the proposal is created, the UI must show the
  // snapshotted quorum — not the live total weight — so that approval progress
  // is measured against the original requirement.

  test("ApprovalBar receives the snapshotted quorumWeight, not the live totalWeight", () => {
    // Snapshot: quorumWeight=10, totalWeight=20 (at creation)
    // After a weight change the live total is now 35 — but the bar must still
    // show progress against the original quorumWeight of 10.
    const proposal = baseProposal({
      approvalWeight: 7,
      quorumWeight: 10,   // snapshotted at creation
      totalWeight: 35,    // live total after a weight change
    });

    renderProposalCard({ proposal });

    // The label rendered by ApprovalBar reads "approvalWeight / quorumWeight weight"
    expect(screen.getByText("7 / 10 weight")).toBeTruthy();
  });

  test("quorum label uses snapshot even when live total diverges significantly", () => {
    // Snapshot quorumWeight=5; live totalWeight has grown to 100 after many
    // weight increases. Progress must still be measured against 5.
    const proposal = baseProposal({
      approvalWeight: 3,
      quorumWeight: 5,
      totalWeight: 100,
    });

    renderProposalCard({ proposal });

    expect(screen.getByText("3 / 5 weight")).toBeTruthy();
  });

  test("fully approved proposal shows 100% against snapshotted quorum, not live total", () => {
    // approvalWeight meets quorumWeight (snapshot) even though totalWeight is higher.
    const proposal = baseProposal({
      approvalWeight: 10,
      quorumWeight: 10,
      totalWeight: 50,
      status: "ready",
    });

    renderProposalCard({ proposal });

    expect(screen.getByText("10 / 10 weight")).toBeTruthy();
  });

  test("snapshot quorum remains unchanged after a weight-change proposal would alter live total", () => {
    // Two proposals created before and after a weight change.
    // Both must still show their original snapshotted quorumWeight.
    const proposalBeforeChange = baseProposal({
      id: 1,
      approvalWeight: 2,
      quorumWeight: 6,   // threshold at creation: 6
      totalWeight: 12,   // live total now higher after weight change
    });

    const { unmount } = renderProposalCard({ proposal: proposalBeforeChange });
    expect(screen.getByText("2 / 6 weight")).toBeTruthy();
    unmount();

    // A proposal created after the weight change has a different snapshot.
    const proposalAfterChange = baseProposal({
      id: 2,
      approvalWeight: 2,
      quorumWeight: 8,   // threshold may differ post-change
      totalWeight: 12,
    });

    renderProposalCard({ proposal: proposalAfterChange });
    expect(screen.getByText("2 / 8 weight")).toBeTruthy();
  });
});
