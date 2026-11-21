import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WorkflowAutomationPanel } from "./WorkflowAutomationPanel";

describe("WorkflowAutomationPanel", () => {
  it("validates webhook name and HTTPS URL before submitting", () => {
    render(<WorkflowAutomationPanel contractId="C123" canManageWebhooks={true} />);

    fireEvent.change(screen.getByLabelText("Endpoint URL (HTTPS)"), {
      target: { value: "http://127.0.0.1/hook" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add workflow webhook" }));

    expect(
      screen.getByText("Webhook name must be between 1 and 80 characters."),
    ).toBeInTheDocument();
    expect(screen.getByText("Webhook URL must be a public https:// endpoint.")).toBeInTheDocument();
  });

  it("renders existing Zapier and generic webhook subscriptions", () => {
    render(
      <WorkflowAutomationPanel
        contractId="C123"
        canManageWebhooks={false}
        initialWebhooks={[
          {
            id: 1,
            network: "testnet",
            contractId: "C123",
            name: "Zapier Treasury Alerts",
            targetType: "zapier",
            url: "https://hooks.zapier.com/hooks/catch/123/abc/",
            events: ["proposal.created", "treasury.disbursed"],
            enabled: true,
            createdAt: "2026-11-20T00:00:00Z",
          },
        ]}
      />,
    );

    expect(screen.getByText("Owner access required")).toBeInTheDocument();
    expect(screen.getByText("Zapier Treasury Alerts")).toBeInTheDocument();
    expect(screen.getByText(/proposal\.created, treasury\.disbursed/)).toBeInTheDocument();
  });
});
