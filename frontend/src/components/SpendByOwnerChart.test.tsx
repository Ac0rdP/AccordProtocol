import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { SpendByOwnerChart } from "./SpendByOwnerChart";
import type { SpendByOwner } from "../lib/analytics";

vi.mock("recharts", async () => {
  const original = await vi.importActual("recharts");
  return {
    ...original,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
  };
});

const SAMPLE: SpendByOwner[] = [
  {
    owner: "GPROPOSER11111111111111111111111111111111111111111111111",
    shortOwner: "GPROPO...1111",
    total: 800,
    count: 4,
  },
  {
    owner: "GPROPOSER22222222222222222222222222222222222222222222222",
    shortOwner: "GPROPO...2222",
    total: 350,
    count: 2,
  },
];

describe("SpendByOwnerChart", () => {
  test("shows loading state", () => {
    render(<SpendByOwnerChart data={[]} loading />);
    expect(screen.getByText("Loading...")).toBeDefined();
  });

  test("shows empty state when data is empty", () => {
    render(<SpendByOwnerChart data={[]} />);
    expect(
      screen.getByText(
        "No spend data available by proposing owner for the selected filters.",
      ),
    ).toBeDefined();
  });

  test("renders component title when data is present", () => {
    render(<SpendByOwnerChart data={SAMPLE} />);
    expect(screen.getByText("Spend by Proposing Owner")).toBeDefined();
  });

  test("renders short owner addresses in legend list", () => {
    render(<SpendByOwnerChart data={SAMPLE} />);
    expect(screen.getByText("GPROPO...1111")).toBeDefined();
    expect(screen.getByText("GPROPO...2222")).toBeDefined();
  });

  test("renders spend totals in legend list", () => {
    render(<SpendByOwnerChart data={SAMPLE} />);
    expect(screen.getByText("800.00")).toBeDefined();
    expect(screen.getByText("350.00")).toBeDefined();
  });

  test("shows error state with retry action", () => {
    const onRetry = vi.fn();
    render(
      <SpendByOwnerChart
        data={[]}
        error="Failed to load owner spend"
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText("Failed to load owner spend")).toBeDefined();
  });
});
