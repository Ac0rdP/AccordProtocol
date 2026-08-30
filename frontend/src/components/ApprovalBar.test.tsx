import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { ApprovalBar } from "./ApprovalBar";

describe("ApprovalBar", () => {
  test("renders an empty bar at zero progress", () => {
    render(<ApprovalBar approvals={0} threshold={5} />);

    expect(screen.getByText("0/5")).toBeTruthy();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
    expect(screen.getByTestId("approval-bar-fill")).toHaveStyle({ width: "0%" });
  });

  test("fills completely when approvals exactly match quorum", () => {
    render(<ApprovalBar approvals={5} threshold={5} />);

    expect(screen.getByText("5/5")).toBeTruthy();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "5");
    expect(screen.getByTestId("approval-bar-fill")).toHaveStyle({ width: "100%" });
  });

  test("clamps the fill at full width when approvals exceed quorum", () => {
    render(<ApprovalBar approvals={7} threshold={5} />);

    expect(screen.getByText("7/5")).toBeTruthy();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "5");
    expect(screen.getByTestId("approval-bar-fill")).toHaveStyle({ width: "100%" });
    expect(screen.getByRole("progressbar")).toHaveClass("overflow-hidden");
  });
});
