import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, test, vi } from "vitest";
import type { Owner, Proposal } from "../types/accord";
import { GlobalSearch } from "./GlobalSearch";

const navigateMock = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom",
  );
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

const proposals: Proposal[] = [
  {
    id: 7,
    kind: "transfer",
    to: "GTOADDR0001",
    amount: "50",
    token: "USDC",
    description: "Ops stipend",
    approvals: 0,
    threshold: 2,
    status: "pending",
    deadline: "later",
    deadlineTs: 1,
    createdAt: "now",
    proposer: "GFROM0001",
    userHasApproved: false,
    approverAddresses: [],
  },
];

const owners: Owner[] = [{ address: "GOWNER0001", label: "Carol" }];

function renderSearch() {
  return render(
    <MemoryRouter>
      <GlobalSearch proposals={proposals} owners={owners} />
    </MemoryRouter>,
  );
}

describe("GlobalSearch", () => {
  test("lists grouped matches and navigates on Enter", () => {
    renderSearch();
    const input = screen.getByRole("searchbox", {
      name: /search proposals, owners, and recipients/i,
    });
    fireEvent.change(input, { target: { value: "ops" } });

    expect(screen.getByText("Proposals")).toBeInTheDocument();
    expect(screen.getByText("Proposal #7")).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(navigateMock).toHaveBeenCalledWith("/app/proposals/7");
  });

  test("shows owners group when matching a label", () => {
    renderSearch();
    fireEvent.change(
      screen.getByRole("searchbox", {
        name: /search proposals, owners, and recipients/i,
      }),
      { target: { value: "carol" } },
    );
    expect(screen.getByText("Owners")).toBeInTheDocument();
    expect(screen.getByText("Carol")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Carol/i })).toHaveAttribute(
      "href",
      "/app/owners",
    );
  });
});
