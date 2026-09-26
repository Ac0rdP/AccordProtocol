import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { ProposalActivityChart } from "./ProposalActivityChart";
import type { Proposal } from "../types/accord";

vi.mock("recharts", async () => {
  const original = await vi.importActual("recharts");
  return {
    ...original,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
  };
});

describe("ProposalActivityChart", () => {
  test("shows loading state when loading prop is true", () => {
    render(<ProposalActivityChart proposals={[]} loading={true} />);
    expect(screen.getByText("Loading...")).toBeDefined();
  });

  test("shows empty message when data is empty", () => {
    render(<ProposalActivityChart proposals={[]} loading={false} />);
    expect(
      screen.getByText("No proposal activity data available."),
    ).toBeDefined();
  });

  test("renders title and granularity controls", () => {
    render(<ProposalActivityChart proposals={[]} loading={false} />);
    expect(screen.getByText("Proposal Activity")).toBeDefined();
    expect(
      screen.getByText("Proposals created vs executed over time"),
    ).toBeDefined();
    expect(screen.getByTestId("granularity-day")).toBeDefined();
    expect(screen.getByTestId("granularity-week")).toBeDefined();
    expect(screen.getByTestId("granularity-month")).toBeDefined();
  });

  test("shows error state with retry callback", () => {
    const onRetry = vi.fn();
    render(
      <ProposalActivityChart
        proposals={[]}
        loading={false}
        error="Network error"
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText("Network error")).toBeDefined();
    const retryBtn = screen.getByText("Retry");
    fireEvent.click(retryBtn);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test("renders chart when proposals are provided", () => {
    const mockProposals: Proposal[] = [
      {
        id: 1,
        kind: "transfer",
        to: "GABC",
        amount: "100",
        token: "XLM",
        description: "Test 1",
        approvals: 2,
        threshold: 2,
        status: "executed",
        deadline: "2026-09-10",
        deadlineTs: 1788998400,
        createdAt: "2026-09-01T10:00:00Z",
        executedAt: "2026-09-02T12:00:00Z",
        proposer: "GPROP",
        userHasApproved: false,
        approverAddresses: [],
      },
      {
        id: 2,
        kind: "transfer",
        to: "GXYZ",
        amount: "200",
        token: "XLM",
        description: "Test 2",
        approvals: 1,
        threshold: 2,
        status: "pending",
        deadline: "2026-09-15",
        deadlineTs: 1789430400,
        createdAt: "2026-09-01T11:00:00Z",
        proposer: "GPROP",
        userHasApproved: false,
        approverAddresses: [],
      },
    ];

    render(<ProposalActivityChart proposals={mockProposals} loading={false} />);
    expect(screen.getByText("Proposal Activity")).toBeDefined();
    expect(screen.getByTestId("proposal-activity-chart-container")).toBeDefined();
  });

  test("updates granularity on button click", () => {
    const onGranularityChange = vi.fn();
    const mockProposals: Proposal[] = [
      {
        id: 1,
        kind: "transfer",
        to: "GABC",
        amount: "100",
        token: "XLM",
        description: "Test 1",
        approvals: 2,
        threshold: 2,
        status: "executed",
        deadline: "2026-09-10",
        deadlineTs: 1788998400,
        createdAt: "2026-09-01T10:00:00Z",
        executedAt: "2026-09-02T12:00:00Z",
        proposer: "GPROP",
        userHasApproved: false,
        approverAddresses: [],
      },
    ];

    render(
      <ProposalActivityChart
        proposals={mockProposals}
        loading={false}
        onGranularityChange={onGranularityChange}
      />,
    );

    const weekBtn = screen.getByTestId("granularity-week");
    fireEvent.click(weekBtn);
    expect(onGranularityChange).toHaveBeenCalledWith("week");
    expect(weekBtn.getAttribute("aria-pressed")).toBe("true");

    const monthBtn = screen.getByTestId("granularity-month");
    fireEvent.click(monthBtn);
    expect(onGranularityChange).toHaveBeenCalledWith("month");
    expect(monthBtn.getAttribute("aria-pressed")).toBe("true");
  });
});
