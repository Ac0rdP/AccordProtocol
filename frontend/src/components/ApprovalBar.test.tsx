import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, test, expect } from "vitest";
import { ApprovalBar } from "./ApprovalBar";

describe("ApprovalBar - All-Weights-Equal-to-1 Regression", () => {
  test("behaves identically to flat count when weights are equal to 1", () => {
    // 3 owners, threshold 2 (quorumWeight=2, totalWeight=3, approvalWeight=1)
    render(
      <ApprovalBar
        approvalWeight={1}
        quorumWeight={2}
        totalWeight={3}
      />
    );

    expect(screen.getByText("1 / 2 weight")).toBeTruthy();
    expect(screen.getByLabelText(/Approval weight 1 of required quorum 2/i)).toBeTruthy();
  });

  test("reaches 100% quorum progress when approval weight equals required quorum in flat setup", () => {
    // 3 owners, threshold 2, approval weight 2 (equal to quorum weight 2)
    render(
      <ApprovalBar
        approvalWeight={2}
        quorumWeight={2}
        totalWeight={3}
      />
    );

    expect(screen.getByText("2 / 2 weight")).toBeTruthy();
    expect(screen.getByLabelText(/100 percent of quorum achieved/i)).toBeTruthy();
  });

  test("falls back to flat approvals and threshold props when explicit weights are omitted", () => {
    render(
      <ApprovalBar
        approvals={1}
        threshold={2}
      />
    );

    expect(screen.getByText("1 / 2 weight")).toBeTruthy();
  });
});
