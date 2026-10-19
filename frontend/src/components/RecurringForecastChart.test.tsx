import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RecurringForecastChart } from "./RecurringForecastChart";
import type { RecurringSchedule } from "../types/accord";

vi.mock("recharts", async () => {
  const original = (await vi.importActual("recharts")) as any;
  return {
    ...original,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="responsive-container">{children}</div>
    ),
  };
});

describe("RecurringForecastChart", () => {
  const sampleSchedule: RecurringSchedule = {
    id: 1,
    recipient: "GBPLX2P3VWYKPQ7L5RI5OGXQ6T4G7QZMJ3HPQD7FZX5KJ3H2Z4YK5ABC",
    amount: "500",
    interval: 30 * 24 * 3600,
    totalDisbursed: "0",
    status: "active",
    nextDisbursementTs: Date.now() + 86400000,
  };

  it("renders loading state", () => {
    const { container } = render(
      <RecurringForecastChart schedules={[]} loading={true} />,
    );
    expect(container.querySelector(".animate-pulse")).toBeDefined();
  });

  it("renders empty state when no active schedules exist", () => {
    render(<RecurringForecastChart schedules={[]} loading={false} />);
    expect(screen.getByText("No active recurring schedules")).toBeDefined();
    expect(screen.getByText(/Create or activate recurring payment schedules/i)).toBeDefined();
  });

  it("renders forecast metrics and chart when active schedules are provided", () => {
    render(
      <RecurringForecastChart
        schedules={[sampleSchedule]}
        treasuryBalance={5000}
        loading={false}
      />,
    );

    expect(screen.getByText("Projected Recurring Outflow & Runway")).toBeDefined();
    expect(screen.getByText("Estimated Runway")).toBeDefined();
    expect(screen.getByText("Avg Monthly Outflow")).toBeDefined();
    expect(screen.getByTestId("responsive-container")).toBeDefined();
  });

  it("allows switching time horizon between 3m, 6m, and 12m", () => {
    render(
      <RecurringForecastChart
        schedules={[sampleSchedule]}
        treasuryBalance={10000}
      />,
    );

    const btn12m = screen.getByRole("button", { name: "12m" });
    fireEvent.click(btn12m);

    expect(screen.getByText(/Total 12-Month Projection/i)).toBeDefined();
  });
});
