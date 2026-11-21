import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PortfolioDashboardPage } from "./PortfolioDashboardPage";
import { PORTFOLIO_STORAGE_KEY } from "../lib/portfolio";

const { getPortfolioContractSummary } = vi.hoisted(() => ({
  getPortfolioContractSummary: vi.fn(),
}));

vi.mock("../lib/contract", () => ({ getPortfolioContractSummary }));

const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M";

const summary = {
  contractId,
  owners: 3,
  totalWeight: 5,
  threshold: 3,
  totalProposals: 4,
  activeProposals: 2,
  readyProposals: 1,
  overdueProposals: 0,
  treasuryXlm: "12.5",
  treasuryUsdc: "3.25",
};

function renderPage() {
  return render(
    <PortfolioDashboardPage
      activeContractId={contractId}
      onSelectContract={vi.fn()}
    />,
  );
}

afterEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe("PortfolioDashboardPage", () => {
  it("announces loading before portfolio summaries arrive", async () => {
    window.localStorage.setItem(
      PORTFOLIO_STORAGE_KEY,
      JSON.stringify([contractId]),
    );
    let resolveSummary!: (value: typeof summary) => void;
    getPortfolioContractSummary.mockReturnValue(
      new Promise((resolve) => {
        resolveSummary = resolve;
      }),
    );

    renderPage();
    expect(
      await screen.findByText("Loading portfolio contracts"),
    ).toBeInTheDocument();

    resolveSummary(summary);
    expect(await screen.findByText("Aggregate health")).toBeInTheDocument();
  });

  it("shows an empty state when no contracts are saved", async () => {
    window.localStorage.setItem(PORTFOLIO_STORAGE_KEY, "[]");

    renderPage();

    expect(
      await screen.findByText("No contracts in your portfolio"),
    ).toBeInTheDocument();
  });

  it("surfaces contract loading errors with a retry action", async () => {
    window.localStorage.setItem(
      PORTFOLIO_STORAGE_KEY,
      JSON.stringify([contractId]),
    );
    getPortfolioContractSummary.mockRejectedValue(new Error("RPC unavailable"));

    renderPage();

    expect(await screen.findByText("Could not load portfolio")).toBeInTheDocument();
    expect(await screen.findByText(/RPC unavailable/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("rejects malformed contract IDs before saving them", async () => {
    window.localStorage.setItem(PORTFOLIO_STORAGE_KEY, "[]");
    renderPage();

    fireEvent.change(await screen.findByLabelText("Add Accord contract"), {
      target: { value: "not-a-contract" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add contract" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter a valid Stellar contract ID.",
    );
    await waitFor(() => {
      expect(window.localStorage.getItem(PORTFOLIO_STORAGE_KEY)).toBe("[]");
    });
  });
});
