import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RecurringPage } from "./RecurringPage";
import * as contract from "../lib/contract";

vi.mock("../lib/contract", () => ({
  getTotalRecurringPayments: vi.fn(),
  getRecurringPaymentsPaged: vi.fn(),
  getLatestLedger: vi.fn().mockResolvedValue(100),
}));

vi.mock("recharts", async () => {
  const original = (await vi.importActual("recharts")) as any;
  return {
    ...original,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="responsive-container">{children}</div>
    ),
  };
});

describe("RecurringPage", () => {
  it("renders recurring page with forecast chart and active schedules", async () => {
    vi.mocked(contract.getTotalRecurringPayments).mockResolvedValue(1);
    vi.mocked(contract.getRecurringPaymentsPaged).mockResolvedValue([
      {
        id: 1,
        recipient: "GBPLX2P3VWYKPQ7L5RI5OGXQ6T4G7QZMJ3HPQD7FZX5KJ3H2Z4YK5ABC",
        amount: "250",
        token: "XLM",
        interval: 30 * 24 * 3600,
        totalDisbursed: "0",
        status: "active",
        nextDisbursementTs: Date.now() + 86400000,
      },
    ]);

    render(<RecurringPage walletAddress="GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4IQDNC" />);

    expect(screen.getByText("Recurring Schedules")).toBeDefined();

    await waitFor(() => {
      expect(screen.getByText("Projected Recurring Outflow & Runway")).toBeDefined();
      expect(screen.getByText("Estimated Runway")).toBeDefined();
    });
  });
});
