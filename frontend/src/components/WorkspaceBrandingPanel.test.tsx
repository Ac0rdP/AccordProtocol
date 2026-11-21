import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WorkspaceBrandingPanel } from "./WorkspaceBrandingPanel";

describe("WorkspaceBrandingPanel", () => {
  it("shows validation errors when invalid color or domain is submitted", () => {
    render(<WorkspaceBrandingPanel contractId="C123" canEdit={true} />);

    fireEvent.change(screen.getByLabelText("Primary color"), { target: { value: "invalid" } });
    fireEvent.change(screen.getByLabelText("Custom domain"), { target: { value: "bad domain" } });
    fireEvent.click(screen.getByRole("button", { name: "Save branding" }));

    expect(
      screen.getByText("Primary color must be a 6-digit hex value (e.g. #2563eb)."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Enter a valid hostname such as treasury.acme.org."),
    ).toBeInTheDocument();
  });

  it("renders DNS verification instructions when a custom domain is configured", () => {
    render(
      <WorkspaceBrandingPanel
        contractId="C123"
        canEdit={false}
        initialBranding={{
          network: "testnet",
          contractId: "C123",
          brandName: "Acme DAO",
          logoUrl: "https://cdn.acme.org/logo.svg",
          primaryColor: "#1d4ed8",
          accentColor: "#0ea5e9",
          customDomain: "treasury.acme.org",
          domainStatus: "pending",
          verificationToken: "accord-verify=deadbeef",
        }}
      />,
    );

    expect(screen.getByText("Owner access required")).toBeInTheDocument();
    expect(screen.getByText("_accord-verification.treasury.acme.org")).toBeInTheDocument();
    expect(screen.getByText("accord-verify=deadbeef")).toBeInTheDocument();
  });
});
