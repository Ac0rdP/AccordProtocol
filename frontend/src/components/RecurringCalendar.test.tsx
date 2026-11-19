import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RecurringCalendar } from "./RecurringCalendar";
import type { RecurringSchedule } from "../types/accord";

const schedule: RecurringSchedule = {
  id: 7,
  recipient: "GABC",
  amount: "250",
  token: "XLM",
  totalDisbursed: "0",
  status: "active",
  interval: 7 * 86_400,
  nextDisbursementTs: new Date(2026, 5, 10, 12).getTime(),
};

describe("RecurringCalendar", () => {
  it("shows loading, error and empty states", () => {
    const { rerender } = render(<RecurringCalendar schedules={[]} loading />);
    expect(screen.getByText("Loading calendar…")).toBeInTheDocument();
    rerender(<RecurringCalendar schedules={[]} error="Boom" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Boom");
    rerender(<RecurringCalendar schedules={[]} />);
    expect(screen.getByText("Nothing scheduled")).toBeInTheDocument();
  });

  it("lists payments for the selected day and moves with arrow keys", () => {
    render(<RecurringCalendar schedules={[schedule]} initialDate={new Date(2026, 5, 9)} />);
    expect(screen.getByText("No payments on this day.")).toBeInTheDocument();

    const grid = screen.getByRole("grid");
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    expect(screen.getByText("Schedule #7")).toBeInTheDocument();
    expect(screen.getByText("due")).toBeInTheDocument();
  });

  it("switches to week view", () => {
    render(<RecurringCalendar schedules={[schedule]} initialDate={new Date(2026, 5, 9)} />);
    fireEvent.click(screen.getByRole("button", { name: "week" }));
    expect(screen.getAllByRole("gridcell")).toHaveLength(7);
  });
});
