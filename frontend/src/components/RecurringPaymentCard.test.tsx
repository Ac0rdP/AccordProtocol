import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { vi, describe, test, expect, beforeEach } from "vitest";
import type { RecurringSchedule } from "../types/accord";
import { RecurringPaymentCard } from "./RecurringPaymentCard";

const mockDisburse = vi.fn();
const mockPause = vi.fn();
const mockResume = vi.fn();
const mockCancel = vi.fn();

vi.mock("../hooks/useRecurringPayments", () => ({
  useRecurringPayments: () => ({
    schedules: [],
    loading: false,
    error: null,
    disburse: mockDisburse,
    pause: mockPause,
    resume: mockResume,
    cancel: mockCancel,
    refresh: vi.fn(),
  }),
}));

const baseSchedule = (
  overrides: Partial<RecurringSchedule> = {}
): RecurringSchedule => ({
  id: 1,
  recipient: "GBPLX2P3VWYKPQ7L5RI5OGXQ6T4G7QZMJ3HPQD7FZX5KJ3H2Z4YK5ABC",
  amount: "50 XLM",
  cadence: "Monthly",
  interval: 2592000,
  totalDisbursed: "150 XLM",
  status: "active",
  description: "Developer grant monthly allowance",
  ...overrides,
});

function renderCard({
  schedule = baseSchedule(),
  walletAddress = "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4IQDNC",
  isDue,
  onDisburse,
  onPause,
  onResume,
  onCancel,
}: {
  schedule?: RecurringSchedule;
  walletAddress?: string | null;
  isDue?: boolean;
  onDisburse?: (id: number) => void;
  onPause?: (id: number) => void;
  onResume?: (id: number) => void;
  onCancel?: (id: number) => void;
} = {}) {
  return render(
    <MemoryRouter>
      <RecurringPaymentCard
        schedule={schedule}
        walletAddress={walletAddress}
        isDue={isDue}
        onDisburse={onDisburse}
        onPause={onPause}
        onResume={onResume}
        onCancel={onCancel}
      />
    </MemoryRouter>
  );
}

describe("RecurringPaymentCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("due schedule renders enabled Disburse now button", () => {
    renderCard({ isDue: true });

    const disburseBtn = screen.getByRole("button", { name: "Disburse schedule 1 now" });
    expect(disburseBtn).toBeDefined();
    expect(disburseBtn).not.toBeDisabled();
    expect(screen.getByText("Payment is due")).toBeDefined();
  });

  test("calls disburse callback or hook when Disburse now button is clicked", () => {
    renderCard({ isDue: true });

    const disburseBtn = screen.getByRole("button", { name: "Disburse schedule 1 now" });
    fireEvent.click(disburseBtn);

    expect(mockDisburse).toHaveBeenCalledWith(1);
  });

  test("non-due schedule renders disabled button with tooltip", () => {
    renderCard({ isDue: false });

    const disburseBtn = screen.getByRole("button", {
      name: "Next disbursement not yet due",
    });
    expect(disburseBtn).toBeDefined();
    expect(disburseBtn).toBeDisabled();
    expect(
      screen.getByTitle("Next disbursement not yet due")
    ).toBeDefined();
    expect(screen.getByText("Next payment pending")).toBeDefined();
  });

  describe("Status variants", () => {
    test("Active status variant shows Active badge, Disburse, Pause, and Cancel buttons", () => {
      renderCard({
        schedule: baseSchedule({ status: "active" }),
        walletAddress: "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4IQDNC",
      });

      expect(screen.getByText("Active")).toBeDefined();
      expect(screen.getByRole("button", { name: /disburse/i })).toBeDefined();
      expect(screen.getByRole("button", { name: /pause/i })).toBeDefined();
      expect(screen.getByRole("button", { name: /cancel/i })).toBeDefined();
    });

    test("Paused status variant shows Paused badge, Resume, and Cancel buttons, and hides Disburse", () => {
      renderCard({
        schedule: baseSchedule({ status: "paused" }),
      });

      expect(screen.getByText("Paused")).toBeDefined();
      expect(screen.getByRole("button", { name: /resume/i })).toBeDefined();
      expect(screen.getByRole("button", { name: /cancel/i })).toBeDefined();
      expect(screen.queryByRole("button", { name: /disburse/i })).toBeNull();
    });

    test("calls pause and resume handlers when clicked", () => {
      const { unmount } = renderCard({
        schedule: baseSchedule({ status: "active" }),
      });
      fireEvent.click(screen.getByRole("button", { name: /pause/i }));
      expect(mockPause).toHaveBeenCalledWith(1);
      unmount();

      renderCard({
        schedule: baseSchedule({ status: "paused" }),
      });
      fireEvent.click(screen.getByRole("button", { name: /resume/i }));
      expect(mockResume).toHaveBeenCalledWith(1);
    });

    test("Completed status variant shows Completed badge and no action buttons", () => {
      renderCard({
        schedule: baseSchedule({ status: "completed" }),
      });

      expect(screen.getByText("Completed")).toBeDefined();
      expect(screen.getByText("Schedule completed")).toBeDefined();
      expect(screen.queryByRole("button", { name: /disburse/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /pause/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /resume/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
    });

    test("Cancelled status variant shows Cancelled badge and no action buttons", () => {
      renderCard({
        schedule: baseSchedule({ status: "cancelled" }),
      });

      expect(screen.getByText("Cancelled")).toBeDefined();
      expect(screen.getByText("Schedule cancelled")).toBeDefined();
      expect(screen.queryByRole("button", { name: /disburse/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /pause/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /resume/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
    });
  });
});
