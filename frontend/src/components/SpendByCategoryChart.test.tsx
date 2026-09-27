import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { SpendByCategoryChart } from "./SpendByCategoryChart";
import type { SpendByCategoryRow } from "../lib/analytics";

vi.mock("recharts", async () => {
  const original = await vi.importActual("recharts");
  return {
    ...original,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
  };
});

const SAMPLE: SpendByCategoryRow[] = [
  { category: "Grant", total: 600, count: 3, share: 60 },
  { category: "Payroll", total: 300, count: 2, share: 30 },
  { category: "Ops", total: 100, count: 1, share: 10 },
];

describe("SpendByCategoryChart", () => {
  test("shows loading state", () => {
    render(<SpendByCategoryChart data={[]} loading />);
    expect(screen.getByText("Loading...")).toBeDefined();
  });

  test("shows empty state when data is empty", () => {
    render(<SpendByCategoryChart data={[]} />);
    expect(
      screen.getByText(
        "No spend data available for the selected filters.",
      ),
    ).toBeDefined();
  });

  test("renders title when data is present", () => {
    render(<SpendByCategoryChart data={SAMPLE} />);
    expect(screen.getByText("Spend by Category")).toBeDefined();
  });

  test("renders a legend row per category", () => {
    render(<SpendByCategoryChart data={SAMPLE} />);
    expect(screen.getByText("Grant")).toBeDefined();
    expect(screen.getByText("Payroll")).toBeDefined();
    expect(screen.getByText("Ops")).toBeDefined();
  });

  test("formats share consistently with one decimal place", () => {
    render(<SpendByCategoryChart data={SAMPLE} />);
    // 60% -> "60.0%", 30% -> "30.0%", 10% -> "10.0%"
    expect(screen.getByText("60.0%")).toBeDefined();
    expect(screen.getByText("30.0%")).toBeDefined();
    expect(screen.getByText("10.0%")).toBeDefined();
  });

  test("shows error state", () => {
    const onRetry = vi.fn();
    render(
      <SpendByCategoryChart
        data={[]}
        error="Category fetch failed"
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText("Category fetch failed")).toBeDefined();
  });
});
