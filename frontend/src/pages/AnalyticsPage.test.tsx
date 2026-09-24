import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, test, vi, beforeEach } from "vitest";
import { AnalyticsPage } from "./AnalyticsPage";
import type { Proposal } from "../types/accord";

vi.mock("../lib/contract", () => ({
  getThreshold: vi.fn(),
  getTotalProposals: vi.fn(),
  getProposalsPaged: vi.fn(),
  mapProposal: vi.fn(),
  getContractXlmBalance: vi.fn(),
  getContractUsdcBalance: vi.fn(),
}));

import {
  getThreshold,
  getTotalProposals,
  getProposalsPaged,
  mapProposal,
  getContractXlmBalance,
  getContractUsdcBalance,
} from "../lib/contract";

function rawProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 1,
    kind: "transfer",
    to: "GRECIPIENT",
    amount: "100",
    token: "XLM",
    description: "Grant payment",
    approvals: 2,
    threshold: 2,
    status: "executed",
    deadline: "Jan 15, 2026",
    deadlineTs: 1768435200,
    createdAt: "proposal #1",
    proposer: "GPROPOSER1",
    userHasApproved: true,
    approverAddresses: ["GA1", "GA2"],
    category: "Grant",
    ...overrides,
  };
}

function mockSuccessfulLoad(proposals: Proposal[]) {
  vi.mocked(getThreshold).mockResolvedValue(2);
  vi.mocked(getTotalProposals).mockResolvedValue(proposals.length);
  vi.mocked(getProposalsPaged).mockResolvedValue(proposals as unknown[]);
  vi.mocked(mapProposal).mockImplementation((raw) => raw as Proposal);
  vi.mocked(getContractXlmBalance).mockResolvedValue("1000");
  vi.mocked(getContractUsdcBalance).mockResolvedValue("500");
}

describe("AnalyticsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("shows a loading state while fetching", () => {
    vi.mocked(getThreshold).mockReturnValue(new Promise(() => {}));
    vi.mocked(getTotalProposals).mockReturnValue(new Promise(() => {}));
    vi.mocked(getContractXlmBalance).mockReturnValue(new Promise(() => {}));
    vi.mocked(getContractUsdcBalance).mockReturnValue(new Promise(() => {}));

    render(<AnalyticsPage />);

    expect(screen.getAllByText("Loading...")).toHaveLength(2);
  });

  test("renders stat cards and charts once data loads", async () => {
    mockSuccessfulLoad([
      rawProposal({ id: 1, amount: "100", category: "Grant" }),
      rawProposal({ id: 2, amount: "50", category: "Payroll" }),
    ]);

    render(<AnalyticsPage />);

    await waitFor(() => expect(screen.getByText("150.00")).toBeInTheDocument());
    expect(screen.getByText("2")).toBeInTheDocument(); // transaction count
    expect(screen.getByText("1000")).toBeInTheDocument(); // XLM balance
    expect(screen.getByText("500")).toBeInTheDocument(); // USDC balance
  });

  test("shows an empty state when there is no executed transfer data", async () => {
    mockSuccessfulLoad([]);

    render(<AnalyticsPage />);

    await waitFor(() =>
      expect(
        screen.getByText("No spend data matches the selected filters."),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByText("No treasury flow data matches the selected filters."),
    ).toBeInTheDocument();
  });

  test("shows an error state with a working retry action", async () => {
    vi.mocked(getThreshold).mockRejectedValue(new Error("RPC unavailable"));
    vi.mocked(getTotalProposals).mockResolvedValue(0);
    vi.mocked(getContractXlmBalance).mockResolvedValue("0");
    vi.mocked(getContractUsdcBalance).mockResolvedValue("0");

    render(<AnalyticsPage />);

    await waitFor(() =>
      expect(screen.getAllByText("RPC unavailable")).toHaveLength(2),
    );

    mockSuccessfulLoad([rawProposal()]);
    const retryButtons = screen.getAllByRole("button", { name: /retry/i });
    fireEvent.click(retryButtons[0]);

    await waitFor(() => expect(screen.getByText("100.00")).toBeInTheDocument());
  });
});
