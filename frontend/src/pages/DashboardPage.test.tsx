import React from "react";
import { MemoryRouter } from "react-router-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { DashboardPage } from "./DashboardPage";
import type { RoleAccessBanner } from "../hooks/useRoles";

vi.mock("../lib/contract", () => ({
  getDueRecurring: vi.fn().mockResolvedValue([]),
  getOwnerWeightChangeEvents: vi.fn().mockResolvedValue([]),
  getHistoricalWeightChangeEvents: vi.fn().mockResolvedValue([]),
  getOwnerWeights: vi.fn().mockResolvedValue({}),
  getRequiredQuorumWeight: vi.fn().mockResolvedValue(0),
}));

vi.mock("../hooks/useOwnerWeights", () => ({
  useOwnerWeights: () => ({
    weights: {},
    totalWeight: 0,
    loading: false,
    error: null,
  }),
}));

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
  walletRoles: [],
  roleBanner: null,
  loading: false,
  error: null,
};

function renderDashboard(roleBanner: RoleAccessBanner | null) {
  return render(
    <MemoryRouter>
      <DashboardPage {...baseProps} roleBanner={roleBanner} />
    </MemoryRouter>,
  );
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
      <MemoryRouter>
        <DashboardPage
          {...baseProps}
          roleBanner={{
            key: "unrecognized:GCONNECTED",
            variant: "unrecognized",
            title: "Unrecognized wallet",
            message: "This wallet is not assigned a role in this Accord.",
          }}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Unrecognized wallet")).toBeTruthy();
  });
});
