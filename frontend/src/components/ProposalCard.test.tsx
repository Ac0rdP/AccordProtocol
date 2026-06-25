import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  to: "GABCDE...WXYZ",
  amount: "100",
  token: "USDC",
  description: "Test proposal",
  approvals: 1,
  threshold: 2,
  status: "pending",
  deadline: "Jun 24, 2026",
  deadlineTs: 1782259200,
  createdAt: "proposal #42",
  proposer: "GPROPO...SER1",
  userHasApproved: false,
  ...overrides,
});

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
    render(
      <ProposalCard
        proposal={baseProposal()}
        walletAddress="GCONNECTED123"
        onApprove={vi.fn()}
        onExecute={vi.fn()}
        onRevoke={vi.fn()}
      />
    );

    expect(screen.getByText("Approve")).toBeTruthy();
  });

  test("shows Connect & Approve for a pending proposal without a wallet", () => {
    render(
      <ProposalCard
        proposal={baseProposal()}
        walletAddress={null}
        onApprove={vi.fn()}
        onExecute={vi.fn()}
        onRevoke={vi.fn()}
      />
    );

    expect(screen.getByText("Connect & Approve")).toBeTruthy();
  });

  test("shows Execute for a ready proposal and hides Approve", () => {
    render(
      <ProposalCard
        proposal={baseProposal({ status: "ready" })}
        walletAddress="GCONNECTED123"
        onApprove={vi.fn()}
        onExecute={vi.fn()}
        onRevoke={vi.fn()}
      />
    );

    expect(screen.getByText("Execute")).toBeTruthy();
    expect(screen.queryByText("Approve")).toBeNull();
  });

  test.each(["executed", "expired"] as const)(
    "hides action buttons for %s proposals",
    (status) => {
      render(
        <ProposalCard
          proposal={baseProposal({ status })}
          walletAddress="GCONNECTED123"
          onApprove={vi.fn()}
          onExecute={vi.fn()}
          onRevoke={vi.fn()}
        />
      );

      expect(screen.queryByText("Approve")).toBeNull();
      expect(screen.queryByText("Execute")).toBeNull();
      expect(screen.queryByText("Connect & Approve")).toBeNull();
    }
  );

  test("calls onApprove with the proposal id", async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();

    render(
      <ProposalCard
        proposal={baseProposal()}
        walletAddress="GCONNECTED123"
        onApprove={onApprove}
        onExecute={vi.fn()}
        onRevoke={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: /approve proposal/i }));

    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith(42);
  });

  test("copies the direct proposal URL and shows temporary feedback", async () => {
    vi.useFakeTimers();

    render(
      <ProposalCard
        proposal={baseProposal()}
        walletAddress="GCONNECTED123"
        onApprove={vi.fn()}
        onExecute={vi.fn()}
        onRevoke={vi.fn()}
      />
    );

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
});
