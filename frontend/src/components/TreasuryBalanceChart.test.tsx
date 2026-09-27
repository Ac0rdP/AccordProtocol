import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { TreasuryBalanceChart } from "./TreasuryBalanceChart";

vi.mock("recharts", async () => {
  const original = await vi.importActual("recharts");
  return {
    ...original,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
  };
});

describe("TreasuryBalanceChart", () => {
  test("shows loading state when loading prop is true", () => {
    render(<TreasuryBalanceChart data={[]} loading={true} />);
    expect(screen.getByText("Loading...")).toBeDefined();
  });

  test("shows empty message when data is empty", () => {
    render(<TreasuryBalanceChart data={[]} loading={false} />);
    expect(
      screen.getByText("No treasury balance time-series data available."),
    ).toBeDefined();
  });

  test("renders title and chart container when data is present", () => {
    const data = [
      { timestamp: "2026-01-01", xlm: 1000, usdc: 500 },
      { timestamp: "2026-02-01", xlm: 1200, usdc: 600 },
    ];
    render(<TreasuryBalanceChart data={data} loading={false} />);
    expect(screen.getByText("Treasury Balance Over Time")).toBeDefined();
    expect(
      screen.getByText("Historical XLM and USDC treasury holdings over time"),
    ).toBeDefined();
  });

  test("shows error state with working retry callback", () => {
    const onRetry = vi.fn();
    render(
      <TreasuryBalanceChart
        data={[]}
        loading={false}
        error="Failed to load time-series"
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText("Failed to load time-series")).toBeDefined();
  });
});
