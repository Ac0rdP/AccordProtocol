import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { TreasuryFlowChart } from "./TreasuryFlowChart";
import type { TreasuryFlowBucket } from "../types/accord";

vi.mock("recharts", async () => {
  const original = await vi.importActual("recharts");
  return {
    ...original,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
  };
});

const sampleBuckets: TreasuryFlowBucket[] = [
  {
    timestamp: "2026-07-01T00:00:00Z",
    token: "XLM",
    inflow: "2000",
    outflow: "1250.5",
  },
  {
    timestamp: "2026-08-01T00:00:00Z",
    token: "XLM",
    inflow: "500",
    outflow: "300",
  },
  {
    timestamp: "2026-07-01T00:00:00Z",
    token: "USDC",
    inflow: "100",
    outflow: "50",
  },
];

describe("TreasuryFlowChart", () => {
  test("shows loading state when loading prop is true", () => {
    render(<TreasuryFlowChart data={[]} loading={true} />);
    expect(screen.getByText("Loading...")).toBeDefined();
  });

  test("shows empty message when data is empty", () => {
    render(<TreasuryFlowChart data={[]} loading={false} />);
    expect(
      screen.getByText("No treasury flow data matches the selected filters."),
    ).toBeDefined();
  });

  test("shows error state and calls onRetry when retry is clicked", () => {
    const onRetry = vi.fn();
    render(
      <TreasuryFlowChart
        data={[]}
        loading={false}
        error="Network error"
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText("Network error")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test("renders chart title, subtitle and granularity controls", () => {
    render(<TreasuryFlowChart data={sampleBuckets} loading={false} />);
    expect(screen.getByText("Treasury Inflow vs Outflow")).toBeDefined();
    expect(
      screen.getByText("Deposits and executed transfers per window"),
    ).toBeDefined();
    expect(screen.getByTestId("flow-granularity-day")).toBeDefined();
    expect(screen.getByTestId("flow-granularity-week")).toBeDefined();
    expect(screen.getByTestId("flow-granularity-month")).toBeDefined();
  });

  test("renders accessible chart container when data is present", () => {
    render(<TreasuryFlowChart data={sampleBuckets} loading={false} />);
    expect(
      screen.getByRole("img", { name: /treasury inflow vs outflow chart/i }),
    ).toBeDefined();
  });

  test("monthly granularity is active by default", () => {
    render(<TreasuryFlowChart data={sampleBuckets} loading={false} />);
    expect(
      screen.getByTestId("flow-granularity-month").getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByTestId("flow-granularity-day").getAttribute("aria-pressed"),
    ).toBe("false");
    expect(
      screen.getByTestId("flow-granularity-week").getAttribute("aria-pressed"),
    ).toBe("false");
  });

  test("clicking a granularity button updates aria-pressed and calls onGranularityChange", () => {
    const onGranularityChange = vi.fn();
    render(
      <TreasuryFlowChart
        data={sampleBuckets}
        loading={false}
        onGranularityChange={onGranularityChange}
      />,
    );

    const weekBtn = screen.getByTestId("flow-granularity-week");
    fireEvent.click(weekBtn);
    expect(onGranularityChange).toHaveBeenCalledWith("week");
    expect(weekBtn.getAttribute("aria-pressed")).toBe("true");

    const dayBtn = screen.getByTestId("flow-granularity-day");
    fireEvent.click(dayBtn);
    expect(onGranularityChange).toHaveBeenCalledWith("day");
    expect(dayBtn.getAttribute("aria-pressed")).toBe("true");
  });

  test("controlled granularity prop overrides internal state", () => {
    const { rerender } = render(
      <TreasuryFlowChart
        data={sampleBuckets}
        loading={false}
        granularity="day"
      />,
    );
    expect(
      screen.getByTestId("flow-granularity-day").getAttribute("aria-pressed"),
    ).toBe("true");

    rerender(
      <TreasuryFlowChart
        data={sampleBuckets}
        loading={false}
        granularity="week"
      />,
    );
    expect(
      screen.getByTestId("flow-granularity-week").getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByTestId("flow-granularity-day").getAttribute("aria-pressed"),
    ).toBe("false");
  });

  test("merges per-token buckets for the same timestamp into one chart point", () => {
    // sampleBuckets has two tokens for 2026-07 — the chart should have 2 bars not 3.
    render(<TreasuryFlowChart data={sampleBuckets} loading={false} />);
    // aria-label mentions the count of data points
    const img = screen.getByRole("img", { name: /treasury inflow vs outflow chart/i });
    expect(img.getAttribute("aria-label")).toContain("2 data points");
  });

  test("screen-reader summary mentions inflow and outflow totals", () => {
    render(<TreasuryFlowChart data={sampleBuckets} loading={false} />);
    // The sr-only paragraph should contain total figures
    const srText = document.querySelector(".sr-only")?.textContent ?? "";
    expect(srText).toMatch(/Total inflow/i);
    expect(srText).toMatch(/Total outflow/i);
  });

  test("granularity buttons display correct labels", () => {
    render(<TreasuryFlowChart data={[]} loading={false} />);
    expect(screen.getByTestId("flow-granularity-day").textContent).toBe("Daily");
    expect(screen.getByTestId("flow-granularity-week").textContent).toBe("Weekly");
    expect(screen.getByTestId("flow-granularity-month").textContent).toBe("Monthly");
  });
});
