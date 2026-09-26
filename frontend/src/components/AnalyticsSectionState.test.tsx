import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { AnalyticsSectionState } from "./AnalyticsSectionState";

describe("AnalyticsSectionState", () => {
  test("renders loading placeholder when loading is true", () => {
    render(
      <AnalyticsSectionState
        loading={true}
        error={null}
        empty={false}
        emptyMessage="No data"
      >
        <div>Content</div>
      </AnalyticsSectionState>,
    );

    expect(screen.getByText("Loading...")).toBeDefined();
    expect(screen.queryByText("Content")).toBeNull();
  });

  test("renders error message and handles retry button click", () => {
    const handleRetry = vi.fn();
    render(
      <AnalyticsSectionState
        loading={false}
        error="Failed to load analytics"
        empty={false}
        emptyMessage="No data"
        onRetry={handleRetry}
      >
        <div>Content</div>
      </AnalyticsSectionState>,
    );

    expect(screen.getByText("Failed to load analytics")).toBeDefined();
    const retryBtn = screen.getByRole("button", { name: "Retry" });
    expect(retryBtn).toBeDefined();

    fireEvent.click(retryBtn);
    expect(handleRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Content")).toBeNull();
  });

  test("renders empty message when empty is true", () => {
    render(
      <AnalyticsSectionState
        loading={false}
        error={null}
        empty={true}
        emptyMessage="No spend data matches the current filters."
      >
        <div>Content</div>
      </AnalyticsSectionState>,
    );

    expect(
      screen.getByText("No spend data matches the current filters."),
    ).toBeDefined();
    expect(screen.queryByText("Content")).toBeNull();
  });

  test("renders children when not loading, no error, and not empty", () => {
    render(
      <AnalyticsSectionState
        loading={false}
        error={null}
        empty={false}
        emptyMessage="No data"
      >
        <div data-testid="chart-content">Chart Rendered Successfully</div>
      </AnalyticsSectionState>,
    );

    expect(screen.getByTestId("chart-content")).toBeDefined();
    expect(screen.getByText("Chart Rendered Successfully")).toBeDefined();
  });
});
