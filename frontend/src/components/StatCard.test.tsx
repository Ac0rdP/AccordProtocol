import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { StatCard } from "./StatCard";

describe("StatCard", () => {
  test("renders label, value, and subtitle text", () => {
    render(
      <StatCard
        label="Total Treasury Value"
        value="$124,500.00"
        sub="Across XLM and USDC reserves"
      />,
    );

    expect(screen.getByText("Total Treasury Value")).toBeDefined();
    expect(screen.getByText("$124,500.00")).toBeDefined();
    expect(screen.getByText("Across XLM and USDC reserves")).toBeDefined();
  });

  test("renders zero values and numeric strings correctly", () => {
    render(
      <StatCard
        label="Active Proposals"
        value="0"
        sub="No proposals pending approval"
      />,
    );

    expect(screen.getByText("Active Proposals")).toBeDefined();
    expect(screen.getByText("0")).toBeDefined();
    expect(screen.getByText("No proposals pending approval")).toBeDefined();
  });

  test("handles empty subtitle gracefully", () => {
    render(<StatCard label="Monthly Burn" value="1,200 XLM" sub="" />);

    expect(screen.getByText("Monthly Burn")).toBeDefined();
    expect(screen.getByText("1,200 XLM")).toBeDefined();
  });
});
