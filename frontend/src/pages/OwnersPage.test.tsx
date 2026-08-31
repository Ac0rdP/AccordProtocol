import React from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useOwnerWeights } from "../hooks/useOwnerWeights";
import { getSpendingLimit } from "../lib/contract";
import type { Owner } from "../types/accord";
import { OwnersPage } from "./OwnersPage";

vi.mock("../hooks/useOwnerWeights", () => ({
  useOwnerWeights: vi.fn(),
}));

vi.mock("../hooks/useDelegations", () => ({
  useDelegations: vi.fn().mockReturnValue({
    delegations: [],
    loading: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("../components/DelegateModal", () => ({
  DelegateModal: () => null,
}));

vi.mock("../lib/submit", () => ({
  createSpendingLimitProposal: vi.fn(),
}));

vi.mock("../lib/contract", () => ({
  getSpendingLimit: vi.fn().mockResolvedValue(-1n),
}));

const mockUseOwnerWeights = vi.mocked(useOwnerWeights);
const mockGetSpendingLimit = vi.mocked(getSpendingLimit);

const ownerAddresses = ["GOWNER111", "GOWNER222"];
const owners: Owner[] = [
  { address: "GOWNER...R111", label: "Signer 1", weight: 5 },
  { address: "GOWNER...R222", label: "Signer 2", weight: 15 },
];

function renderOwnersPage(props: Partial<React.ComponentProps<typeof OwnersPage>> = {}) {
  render(
    <OwnersPage
      owners={owners}
      ownerAddresses={ownerAddresses}
      threshold={5}
      walletAddress={null}
      onProposalSubmitted={() => undefined}
      {...props}
    />,
  );
}

describe("OwnersPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(screen.getAllByText("Signer 1").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/GOWNER/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Raw 5/)).toBeInTheDocument();
    expect(screen.getAllByText(/Raw 15/).length).toBeGreaterThan(0);
    expect(screen.getByText(/25\.0% of voting power/)).toBeInTheDocument();
    expect(screen.getByText(/75\.0% of voting power/)).toBeInTheDocument();
  });

  test("keeps owners visible while voting weights load", () => {
    mockUseOwnerWeights.mockReturnValue({
      weights: {},
      totalWeight: 0,
      loading: true,
      error: null,
    });

    renderOwnersPage();

    expect(screen.getByText(/Requires.*voting weight/)).toBeInTheDocument();
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

    expect(screen.getByText(/Requires.*voting weight/)).toBeInTheDocument();
    expect(screen.getAllByText("Signer 1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Signer 2").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Weight unavailable")).toHaveLength(2);
  });

  test("renders each owner's weight and percentage share for an uneven multi-owner set", async () => {
    const addresses = ["GALPHA111", "GBRAVO222", "GCHARLIE333"];
    mockUseOwnerWeights.mockReturnValue({
      weights: { GALPHA111: 2, GBRAVO222: 6, GCHARLIE333: 12 },
      totalWeight: 20,
      loading: false,
      error: null,
    });

    render(
      <OwnersPage
        owners={[
          { address: "GALPH...A111", label: "Alpha", weight: 2 },
          { address: "GBRAV...O222", label: "Bravo", weight: 6 },
          { address: "GCHAR...E333", label: "Charlie", weight: 12 },
        ]}
        ownerAddresses={addresses}
        threshold={11}
        walletAddress={null}
        onProposalSubmitted={() => undefined}
      />,
    );

    // Weighted quorum summary reflects the mocked total voting weight.
    expect(
      await screen.findByText("Requires 11 of 20 voting weight"),
    ).toBeInTheDocument();

    // Each owner's raw voting weight is shown.
    expect(screen.getByText("Raw 2")).toBeInTheDocument();
    expect(screen.getByText("Raw 6")).toBeInTheDocument();
    expect(screen.getByText("Raw 12")).toBeInTheDocument();

    // Each owner's share of total voting power (2/20, 6/20, 12/20)
    expect(screen.getByText("· 10.0% of voting power")).toBeInTheDocument();
    expect(screen.getByText("· 30.0% of voting power")).toBeInTheDocument();
    expect(screen.getByText("· 60.0% of voting power")).toBeInTheDocument();
  });

  test("renders a sole owner's complete voting share", async () => {
    const soleOwnerAddress = "GSOLEOWNER";
    mockUseOwnerWeights.mockReturnValue({
      weights: { [soleOwnerAddress]: 100 },
      totalWeight: 100,
      loading: false,
      error: null,
    });

    render(
      <OwnersPage
        owners={[{ address: "GSOLE...WNER", label: "Sole Owner", weight: 100 }]}
        ownerAddresses={[soleOwnerAddress]}
        threshold={100}
        walletAddress={null}
        onProposalSubmitted={() => undefined}
      />,
    );

    expect(screen.getByText("Requires 100 of 100 voting weight")).toBeInTheDocument();
    expect(screen.getByText("Sole Owner")).toBeInTheDocument();
    expect(screen.getByText("· 100.0% of voting power")).toBeInTheDocument();
  });
});
