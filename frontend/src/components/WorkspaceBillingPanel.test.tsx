import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WorkspaceBillingPanel } from "./WorkspaceBillingPanel";

describe("WorkspaceBillingPanel", () => {
  it("displays current plan limits, usage meters, and upgrade CTA", () => {
    render(
      <WorkspaceBillingPanel
        contractId="C123"
        canManageBilling={true}
        initialPlan={{
          network: "testnet",
          contractId: "C123",
          planTier: "free",
          workspacesLimit: 1,
          apiRequestsUsed: 8_500,
          apiRequestsLimit: 10_000,
          reportsUsed: 2,
          reportsLimit: 5,
          integrationsUsed: 1,
          integrationsLimit: 2,
          billingEmail: "ops@acme.org",
          status: "active",
        }}
      />,
    );

    expect(screen.getByText("Upgrade to PRO")).toBeInTheDocument();
    expect(screen.getByText("8,500 / 10,000")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Current plan" })).toBeDisabled();
  });

  it("blocks invalid billing email before calling API", () => {
    render(<WorkspaceBillingPanel contractId="C123" canManageBilling={true} />);

    fireEvent.change(screen.getByLabelText("Billing email"), { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to PRO" }));

    expect(
      screen.getByText("Enter a valid billing email address before updating the plan."),
    ).toBeInTheDocument();
  });
});
