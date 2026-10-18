import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { AnalyticsPage } from "./AnalyticsPage";
import { useTreasuryAnalytics } from "../hooks/useTreasuryAnalytics";

vi.mock("../hooks/useTreasuryAnalytics", () => ({
  useTreasuryAnalytics: vi.fn(),
}));

vi.mock("recharts", async () => {
  const original = await vi.importActual("recharts");
  return {
    ...original,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
  };
});

const refresh = vi.fn();
const save = vi.fn();
vi.mock("jspdf", () => ({
  jsPDF: vi.fn().mockImplementation(() => ({
    setFontSize: vi.fn(),
    text: vi.fn(),
    save,
  })),
}));

const analytics = {
  summary: {
    totalDisbursed: { XLM: "1250.5", USDC: "42" },
    totalInflows: { XLM: "2000" },
    activeProposals: 3,
    ownerCount: 4,
    largestOutflow: null,
  },
  balance: { balances: {} },
  spendByCategory: [
    { category: "Grant" as const, token: "XLM", total: "1250.5", count: 2, share: 100 },
  ],
  spendByOwner: [
    { owner: "GALICE1234567890", token: "XLM", total: "1250.5", count: 2 },
  ],
  flow: [
    { timestamp: "2026-09-01T00:00:00Z", token: "XLM", inflow: "2000", outflow: "1250.5" },
  ],
};

describe("AnalyticsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useTreasuryAnalytics).mockReturnValue({
      data: analytics,
      loading: false,
      error: null,
      refresh,
    });
    global.URL.createObjectURL = vi.fn(() => "blob:analytics");
    global.URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  test("renders the API-backed headline cards with consistently formatted amounts", () => {
    render(<AnalyticsPage />);

    expect(screen.getByText("Total Disbursed")).toBeInTheDocument();
    expect(screen.getByText("42.00 USDC · 1,250.50 XLM")).toBeInTheDocument();
    expect(screen.getByText("Total Inflows")).toBeInTheDocument();
    expect(screen.getByText("2,000.00 XLM")).toBeInTheDocument();
    expect(screen.getByText("Active Proposals")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  test("shows a loading state while fetching", () => {
    vi.mocked(useTreasuryAnalytics).mockReturnValue({
      data: null,
      loading: true,
      error: null,
      refresh,
    });

    render(<AnalyticsPage />);

    expect(screen.getAllByText("Loading...").length).toBeGreaterThanOrEqual(1);
    // Stat cards show ellipsis during loading
    expect(screen.getAllByText("…").length).toBeGreaterThanOrEqual(3);
  });

  test("shows an empty state when there is no data", () => {
    vi.mocked(useTreasuryAnalytics).mockReturnValue({
      data: {
        ...analytics,
        spendByCategory: [],
        spendByOwner: [],
        flow: [],
      },
      loading: false,
      error: null,
      refresh,
    });

    render(<AnalyticsPage />);

    expect(
      screen.getByText("No spend data available for the selected filters."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "No spend data available by proposing owner for the selected filters.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No treasury flow data matches the selected filters."),
    ).toBeInTheDocument();
  });

  test("shows an error state with a working retry action", () => {
    vi.mocked(useTreasuryAnalytics).mockReturnValue({
      data: null,
      loading: false,
      error: "RPC unavailable",
      refresh,
    });

    render(<AnalyticsPage />);

    expect(screen.getAllByText("RPC unavailable").length).toBeGreaterThanOrEqual(1);
    const retryButtons = screen.getAllByRole("button", { name: /retry/i });
    fireEvent.click(retryButtons[0]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test("gives controls and charts accessible names and keeps exports keyboard-operable", () => {
    render(<AnalyticsPage />);

    for (const name of [
      "Filter start date",
      "Filter end date",
      "Filter by category",
      "Filter by owner",
      "Export spend CSV for the current analytics filters",
      "Export treasury CSV for the current analytics filters",
      "Download PDF treasury statement for the current analytics filters",
    ]) {
      expect(screen.getByLabelText(name)).toBeInTheDocument();
    }
    expect(
      screen.getByRole("img", { name: /spend by category chart/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: /spend by proposing owner chart/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: /treasury inflow vs outflow chart/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /export spend csv/i }));
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();
  });

  test("uses the filtered query when controls change", () => {
    render(<AnalyticsPage />);
    fireEvent.change(screen.getByLabelText("Filter by category"), {
      target: { value: "Grant" },
    });
    expect(vi.mocked(useTreasuryAnalytics)).toHaveBeenLastCalledWith(
      expect.objectContaining({ category: "Grant" }),
    );
  });

  test("filtering by category narrows the totals shown", () => {
    render(<AnalyticsPage />);

    vi.mocked(useTreasuryAnalytics).mockReturnValue({
      data: {
        ...analytics,
        summary: {
          ...analytics.summary,
          totalDisbursed: {},
          totalInflows: {},
          activeProposals: 0,
        },
      },
      loading: false,
      error: null,
      refresh,
    });

    const { rerender } = render(<AnalyticsPage />);
    fireEvent.change(screen.getAllByLabelText("Filter by category")[0], {
      target: { value: "Grant" },
    });

    rerender(<AnalyticsPage />);
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("0").length).toBeGreaterThanOrEqual(1);
  });

  test("export buttons are disabled when there is no data", () => {
    vi.mocked(useTreasuryAnalytics).mockReturnValue({
      data: null,
      loading: false,
      error: null,
      refresh,
    });

    render(<AnalyticsPage />);

    expect(
      screen.getByRole("button", { name: /export spend csv/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /export treasury csv/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /download pdf treasury statement/i }),
    ).toBeDisabled();
  });
});
