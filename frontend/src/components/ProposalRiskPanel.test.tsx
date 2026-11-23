import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Proposal } from "../types/accord";
import { ProposalRiskPanel } from "./ProposalRiskPanel";

const proposal = {
  id: 1, kind: "transfer", to: "GNEW", amount: "100", token: "XLM", description: "",
  approvals: 0, threshold: 2, status: "pending", deadline: "", deadlineTs: 4_000_000_000,
  createdAt: "", proposer: "GP", userHasApproved: false, approverAddresses: [],
} as Proposal;

describe("ProposalRiskPanel", () => {
  it("renders warnings for unusual signals", () => {
    render(<ProposalRiskPanel proposal={proposal} history={[{ ...proposal, id: 2, to: "GOLD" }]} />);
    expect(screen.getByText("New recipient")).toBeInTheDocument();
    expect(screen.getByText(/medium risk/i)).toBeInTheDocument();
  });

  it("renders the empty state when nothing is unusual", () => {
    render(<ProposalRiskPanel proposal={proposal} history={[]} />);
    expect(screen.getByText(/No unusual recipient/)).toBeInTheDocument();
  });

  it("renders loading and error states", () => {
    const { rerender } = render(<ProposalRiskPanel proposal={proposal} history={[]} loading />);
    expect(screen.getByText("Checking risk signals…")).toBeInTheDocument();
    rerender(<ProposalRiskPanel proposal={proposal} history={[]} error="Failed" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Failed");
  });
});
