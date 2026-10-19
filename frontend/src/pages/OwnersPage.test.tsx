import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { OwnersPage } from "./OwnersPage";
import type { Owner } from "../types/accord";

const owners: Owner[] = [
  {
    address: "GOWNER...1111",
    fullAddress: "GOWNER1111111111111111111111111111111111111111111111111111",
    label: "Signer 1",
    roles: ["Owner", "Guardian"],
    weight: 2,
  },
  {
    address: "GVIEWR...2222",
    fullAddress: "GVIEWR2222222222222222222222222222222222222222222222222222",
    label: "Signer 2",
    roles: ["Viewer"],
  },
];

describe("OwnersPage", () => {
  test("renders owner role badges while preserving address and weight", () => {
    render(
      <OwnersPage
        owners={owners}
        threshold={1}
        totalOwners={2}
        onManageRoles={vi.fn()}
      />
    );

    expect(screen.getAllByText("GOWNER...1111").length).toBeGreaterThan(0);
    expect(screen.getByText("Weight 2")).toBeTruthy();
    expect(screen.getByText("Owner")).toBeTruthy();
    expect(screen.getByText("Guardian")).toBeTruthy();
    expect(screen.getByText("Viewer")).toBeTruthy();
  });

  test("opens role management for the selected owner", () => {
    const onManageRoles = vi.fn();
    render(
      <OwnersPage
        owners={owners}
        threshold={1}
        totalOwners={2}
        onManageRoles={onManageRoles}
      />
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Manage Roles" })[1]);

    expect(onManageRoles).toHaveBeenCalledWith(owners[1].fullAddress);
  });

  test("renders governance-health score and plain-language explanation", () => {
    render(
      <OwnersPage
        owners={owners}
        threshold={1}
        totalOwners={2}
        onManageRoles={vi.fn()}
      />
    );

    // Widget header & score badge
    expect(screen.getByRole("region", { name: "Governance Health" }) || screen.getByLabelText("Governance Health")).toBeTruthy();
    expect(screen.getByTestId("governance-health-score")).toBeTruthy();
    expect(screen.getByTestId("governance-explanation")).toBeTruthy();
  });

  test("flags risks when dominant owner controls majority weight", () => {
    const skewedOwners: Owner[] = [
      {
        address: "GWHALE...1111",
        fullAddress: "GWHALE1111111111111111111111111111111111111111111111111111",
        label: "Whale Signer",
        roles: ["Owner"],
        weight: 9,
      },
      {
        address: "GMINOW...2222",
        fullAddress: "GMINOW2222222222222222222222222222222222222222222222222222",
        label: "Small Signer",
        roles: ["Owner"],
        weight: 1,
      },
    ];

    render(
      <OwnersPage
        owners={skewedOwners}
        threshold={6}
        totalOwners={2}
        onManageRoles={vi.fn()}
      />
    );

    expect(screen.getByTestId("governance-risks")).toBeTruthy();
    expect(screen.getByText(/Dominant owner controls/)).toBeTruthy();
  });
});

