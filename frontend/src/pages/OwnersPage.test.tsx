import React from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useOwnerWeights } from "../hooks/useOwnerWeights";
import { getWeightCapPct, getRequiredQuorumWeight, getSpendingLimit } from "../lib/contract";
import type { Owner } from "../types/accord";
import { OwnersPage } from "./OwnersPage";

vi.mock("../hooks/useOwnerWeights", () => ({
  useOwnerWeights: vi.fn(),
}));

vi.mock("../lib/contract", () => ({
  getRequiredQuorumWeight: vi.fn().mockResolvedValue(15),
  getSpendingLimit: vi.fn().mockResolvedValue(-1n),
}));

const mockUseOwnerWeights = vi.mocked(useOwnerWeights);
const mockGetWeightCapPct = vi.mocked(getWeightCapPct);
const mockGetRequiredQuorumWeight = vi.mocked(getRequiredQuorumWeight);
const mockGetSpendingLimit = vi.mocked(getSpendingLimit);

const ownerAddresses = ["GOWNER111", "GOWNER222"];
const owners: Owner[] = [
  { address: "GOWNER...R111", label: "Signer 1", weight: 5 },
  { address: "GOWNER...R222", label: "Signer 2", weight: 15 },
];

function renderOwnersPage() {
  render(
    <OwnersPage
      owners={owners}
      ownerAddresses={ownerAddresses}
      threshold={5}
    />,
  );
}

describe("OwnersPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetWeightCapPct.mockResolvedValue(50);
    mockGetRequiredQuorumWeight.mockResolvedValue(10);
    mockGetSpendingLimit.mockResolvedValue(-1n);
  });

  test("shows weighted quorum and each owner voting share", async () => {
    mockUseOwnerWeights.mockReturnValue({
      weights: { GOWNER111: 5, GOWNER222: 15 },
      totalWeight: 20,
      loading: false,
      error: null,
    });

    renderOwnersPage();

    expect(screen.getByText("Requires 5 of 20 voting weight")).toBeInTheDocument();
    expect(screen.getByText("25.0% of voting power must approve."))
      .toBeInTheDocument();
    expect(screen.getAllByText("Signer 1").length).toBeGreaterThan(0);
    expect(screen.getByText(/GOWNER\.\.\.R111/)).toBeInTheDocument();
    expect(screen.getByText(/Weight 5/)).toBeInTheDocument();
    expect(screen.getAllByText(/Weight 15/).length).toBeGreaterThan(0);
    expect(screen.getByText("25.0% of voting power must approve.")).toBeInTheDocument();
  });

  test("keeps owners visible while voting weights load", () => {
    mockUseOwnerWeights.mockReturnValue({
      weights: {},
      totalWeight: 0,
      loading: true,
      error: null,
    });

    renderOwnersPage();

    expect(screen.getByText("Requires 5 voting weight")).toBeInTheDocument();
    expect(
      screen.getByText("Loading voting power across 2 owners..."),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Signer 1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Signer 2").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Loading weight...")).toHaveLength(2);
  });

  test("keeps owners visible when voting weights fail to load", () => {
    mockUseOwnerWeights.mockReturnValue({
      weights: {},
      totalWeight: 0,
      loading: false,
      error: "Failed to load owner weights",
    });

    renderOwnersPage();

    expect(screen.getByText("Requires 5 voting weight")).toBeInTheDocument();
    expect(
      screen.getByText("Voting power unavailable; owners remain visible."),
    ).toBeInTheDocument();
    expect(screen.getByText("Voting weights unavailable.")).toBeInTheDocument();
    expect(screen.getAllByText("Signer 1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Signer 2").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Weight unavailable")).toHaveLength(2);
  });
});
