import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { DashboardPage } from "./DashboardPage";
import type { RoleAccessBanner } from "../hooks/useRoles";

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
  walletRoles: ["Owner"],
  roleBanner: null,
  loading: false,
  error: null,
};

function renderDashboard(roleBanner: RoleAccessBanner | null) {
  return render(<DashboardPage {...baseProps} roleBanner={roleBanner} />);
}

describe("DashboardPage role access banner", () => {
  test("renders Viewer messaging and dismisses it accessibly", () => {
    renderDashboard({
      key: "viewer:GCONNECTED",
      variant: "viewer",
      title: "Viewer access",
      message: "This wallet is recognized as a Viewer.",
    });

    expect(screen.getByRole("status", { name: "Wallet role access" })).toBeTruthy();
    expect(screen.getByText("Viewer access")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss role access message" }));

    expect(screen.queryByText("Viewer access")).toBeNull();
  });

  test("renders limited-role and unrecognized messages distinctly", () => {
    const { rerender } = renderDashboard({
      key: "role-holder:GCONNECTED:Guardian",
      variant: "role-holder",
      title: "Limited role access",
      message: "This wallet holds Guardian.",
    });

    expect(screen.getByText("Limited role access")).toBeTruthy();

    rerender(
      <DashboardPage
        {...baseProps}
        roleBanner={{
          key: "unrecognized:GCONNECTED",
          variant: "unrecognized",
          title: "Unrecognized wallet",
          message: "This wallet is not assigned a role in this Accord.",
        }}
      />
    );

    expect(screen.getByText("Unrecognized wallet")).toBeTruthy();
  });
});

describe("DashboardPage role-gated actions", () => {
  test("disables create actions for a connected wallet without Owner", () => {
    render(<DashboardPage {...baseProps} walletRoles={["Viewer"]} />);

    const newButton = screen.getByRole("button", { name: "New" });
    const recurringButton = screen.getByRole("button", { name: "Recurring" });

    expect(newButton).toBeDisabled();
    expect(recurringButton).toBeDisabled();
    expect(newButton).toHaveAttribute(
      "title",
      "Creating proposals requires the Owner role."
    );
  });

  test("keeps create actions enabled for a connected Owner", () => {
    render(<DashboardPage {...baseProps} walletRoles={["Owner"]} />);

    expect(screen.getByRole("button", { name: "New" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Recurring" })).toBeEnabled();
  });
});
