import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { FiatValue } from "./FiatValue";
import * as priceFeed from "../lib/priceFeed";

vi.mock("../lib/priceFeed", async (importOriginal) => ({
  ...(await importOriginal<typeof priceFeed>()),
  fetchUsdPrices: vi.fn(),
}));

const fetchMock = vi.mocked(priceFeed.fetchUsdPrices);

describe("FiatValue", () => {
  beforeEach(() => fetchMock.mockReset());

  it("shows loading then the approximate USD value with freshness", async () => {
    fetchMock.mockResolvedValue({ XLM: { usd: 0.1, updatedAt: Date.now() } });
    render(<FiatValue amount="250" token="XLM" />);
    expect(screen.getByText("Loading USD value…")).toBeInTheDocument();
    expect(await screen.findByText(/≈ \$25\.00/)).toBeInTheDocument();
    expect(screen.getByText(/price updated just now/)).toBeInTheDocument();
  });

  it("shows an error with retry", async () => {
    fetchMock.mockRejectedValueOnce(new Error("down"));
    fetchMock.mockResolvedValueOnce({ XLM: { usd: 1, updatedAt: Date.now() } });
    render(<FiatValue amount="2" token="XLM" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("USD value unavailable");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(/≈ \$2\.00/)).toBeInTheDocument();
  });

  it("renders nothing for tokens without a price feed", () => {
    fetchMock.mockResolvedValue({});
    const { container } = render(<FiatValue amount="2" token="FOO" />);
    expect(container).toBeEmptyDOMElement();
  });
});
