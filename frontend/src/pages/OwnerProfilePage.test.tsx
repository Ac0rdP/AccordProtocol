import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { OwnerProfilePage } from "./OwnerProfilePage";
import type { Owner, Proposal } from "../types/accord";

describe("OwnerProfilePage", () => {
  const ownerAddress = "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4IQDNC";
  const otherAddress = "GBPLX2P3VWYKPQ7L5RI5OGXQ6T4G7QZMJ3HPQD7FZX5KJ3H2Z4YK5ABC";

  const sampleOwners: Owner[] = [
    {
      label: "Alice",
      address: "GDHU6W…QDNC",
      fullAddress: ownerAddress,
      roles: ["Owner", "Approver"],
      weight: 2,
    },
    {
      label: "Bob",
      address: "GBPLX2…5ABC",
      fullAddress: otherAddress,
      roles: ["Owner"],
      weight: 1,
    },
  ];

  const sampleProposals: Proposal[] = [
    {
      id: 1,
      kind: "transfer",
      to: "GDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      amount: "100",
      token: "XLM",
      proposer: ownerAddress,
      approvers: 1,
      approvals: 1,
      threshold: 2,
      status: "pending",
      userHasApproved: false,
      approverAddresses: [otherAddress],
      createdAt: "2026-01-01",
      deadline: "2026-02-01",
      deadlineTs: 1770000000000,
    },
    {
      id: 2,
      kind: "transfer",
      to: "GDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      amount: "50",
      token: "USDC",
      proposer: otherAddress,
      approvers: 1,
      approvals: 1,
      threshold: 2,
      status: "executed",
      userHasApproved: true,
      approverAddresses: [ownerAddress],
      createdAt: "2026-01-02",
      deadline: "2026-02-01",
      deadlineTs: 1770000000000,
    },
  ];

  const renderComponent = (addr = ownerAddress, proposals = sampleProposals) => {
    return render(
      <MemoryRouter initialEntries={[`/app/owners/${addr}`]}>
        <Routes>
          <Route
            path="/app/owners/:address"
            element={
              <OwnerProfilePage
                proposals={proposals}
                owners={sampleOwners}
              />
            }
          />
        </Routes>
      </MemoryRouter>,
    );
  };

  it("renders owner profile header, metrics, and created proposals", () => {
    renderComponent();

    // Owner header details
    expect(screen.getByText("Alice")).toBeDefined();
    expect(screen.getByText(ownerAddress)).toBeDefined();
    expect(screen.getByText("Weight 2")).toBeDefined();

    // Summary counts: 1 created, 1 approved, 2 total
    expect(screen.getByText("Proposals Created")).toBeDefined();
    expect(screen.getByText("Proposals Approved")).toBeDefined();
    expect(screen.getByText("Total Activity")).toBeDefined();

    // Tab shows 1 created
    expect(screen.getByRole("button", { name: /created \(1\)/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /approved \(1\)/i })).toBeDefined();

    // Proposal #1 appears in Created tab
    expect(screen.getByText("Proposal #1")).toBeDefined();
  });

  it("switches to approved tab and displays approved proposals", () => {
    renderComponent();

    const approvedTab = screen.getByRole("button", { name: /approved \(1\)/i });
    fireEvent.click(approvedTab);

    // Proposal #2 was approved by Alice
    expect(screen.getByText("Proposal #2")).toBeDefined();
  });

  it("renders clear empty state when owner has no activity", () => {
    const emptyOwner = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAA";
    renderComponent(emptyOwner);

    expect(screen.getByText("No activity recorded")).toBeDefined();
    expect(
      screen.getByText("This owner has not created or approved any proposals yet."),
    ).toBeDefined();
  });
});
