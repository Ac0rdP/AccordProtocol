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

    expect(screen.getByText("GOWNER...1111")).toBeTruthy();
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
});
