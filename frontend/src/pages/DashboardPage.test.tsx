import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { DashboardPage } from "./DashboardPage";
import type { Role } from "../types/accord";

const baseProps = {
  activeProposals: [],
  owners: [],
  dashboardStats: [],
  walletAddress: "GCONNECTED",
  onApprove: vi.fn(),
  onExecute: vi.fn(),
  onRevoke: vi.fn(),
  onCreateProposal: vi.fn(),
  onCreateRecurringPayment: vi.fn(),
  walletRoles: ["Proposer"],
  loading: false,
  error: null,
};

describe("DashboardPage role-gated actions", () => {
  test("disables create actions for a connected wallet without Proposer", () => {
    render(<DashboardPage {...baseProps} walletRoles={["Viewer"]} />);

    const newButton = screen.getByRole("button", { name: "New" });
    const recurringButton = screen.getByRole("button", { name: "Recurring" });

    expect(newButton).toBeDisabled();
    expect(recurringButton).toBeDisabled();
    expect(newButton).toHaveAttribute(
      "title",
      "Creating proposals requires the Proposer role."
    );
  });

  test("keeps create actions enabled for a connected Proposer", () => {
    render(<DashboardPage {...baseProps} walletRoles={["Proposer"]} />);

    expect(screen.getByRole("button", { name: "New" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Recurring" })).toBeEnabled();
  });
});


