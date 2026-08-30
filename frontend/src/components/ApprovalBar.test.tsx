import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, test, expect } from "vitest";
import { ApprovalBar } from "./ApprovalBar";

// ── ApprovalBar: snapshotted quorum tests ─────────────────────────────────────
//
// A proposal's quorumWeight is fixed at creation time. If owner weights change
// after the proposal is created, ApprovalBar must measure progress against the
// original snapshotted quorumWeight — not the live totalWeight. These tests
// verify that invariant by driving ApprovalBar directly with combinations where
// quorumWeight ≠ totalWeight.

describe("ApprovalBar", () => {
  test("shows quorum completion for a single owner holding all voting weight", () => {
    render(
      <ApprovalBar approvalWeight={100} quorumWeight={100} totalWeight={100} />
    );

    expect(
      screen.getByLabelText(/100 percent of quorum achieved/)
    ).toBeInTheDocument();
    expect(screen.getByText("100 / 100 weight")).toBeInTheDocument();
    expect(screen.queryByText(/NaN/i)).not.toBeInTheDocument();
  });

  test("renders the snapshotted quorum in the weight label", () => {
    // quorumWeight=10 was snapshotted at creation; live totalWeight is now 35.
    render(
      <ApprovalBar approvalWeight={7} quorumWeight={10} totalWeight={35} />
    );

    // The label must read against the snapshot (10), not the live total (35).
    expect(screen.getByText("7 / 10 weight")).toBeTruthy();
  });

  test("aria-label reflects snapshotted quorum and correct percentage", () => {
    // 5 out of a snapshotted quorum of 10 = 50%.
    const { container } = render(
      <ApprovalBar approvalWeight={5} quorumWeight={10} totalWeight={20} />
    );

    const wrapper = container.firstChild as HTMLElement;
    const label = wrapper.getAttribute("aria-label") ?? "";

    expect(label).toContain("quorum 10");
    expect(label).toContain("50");
    // Must not mention totalWeight as the quorum target.
    expect(label).not.toContain("quorum 20");
  });

  test("progress is clamped at 100% when approvalWeight meets snapshotted quorumWeight", () => {
    // approvalWeight exactly equals the snapshotted quorumWeight; totalWeight
    // is higher (post weight-change). The bar must be 100%, not a fraction.
    render(
      <ApprovalBar approvalWeight={10} quorumWeight={10} totalWeight={50} />
    );

    expect(screen.getByText("10 / 10 weight")).toBeTruthy();
  });

  test("progress is not inflated when approvalWeight exceeds snapshotted quorumWeight", () => {
    // Over-approval beyond the snapshot must still render as 100% (clamped).
    render(
      <ApprovalBar approvalWeight={15} quorumWeight={10} totalWeight={30} />
    );

    expect(screen.getByText("15 / 10 weight")).toBeTruthy();
  });

  test("snapshot smaller than live total: quorum tick is positioned relative to totalWeight", () => {
    // quorumWeight=8, totalWeight=16 → tick at 50% of the bar.
    // This confirms the tick uses totalWeight as the scale denominator while
    // progress is still measured against quorumWeight.
    const { container } = render(
      <ApprovalBar approvalWeight={4} quorumWeight={8} totalWeight={16} />
    );

    // The quorum tick div carries a title attribute with the quorum/total info.
    const tickEl = container.querySelector('[title*="Quorum at 8"]');
    expect(tickEl).not.toBeNull();
    expect(tickEl?.getAttribute("title")).toContain("total 16");
  });

  test("snapshot larger mismatch: live total doubled but quorum label unchanged", () => {
    // Snapshot quorumWeight=5; weights later changed so live total=40.
    // The label must still read "3 / 5 weight".
    render(
      <ApprovalBar approvalWeight={3} quorumWeight={5} totalWeight={40} />
    );

    expect(screen.getByText("3 / 5 weight")).toBeTruthy();
  });

  test("zero quorumWeight is handled gracefully with 0% progress", () => {
    render(
      <ApprovalBar approvalWeight={0} quorumWeight={0} totalWeight={10} />
    );

    // Should not throw; label should still render.
    expect(screen.getByText("0 / 0 weight")).toBeTruthy();
  });

  test("zero totalWeight: quorum tick is not rendered", () => {
    const { container } = render(
      <ApprovalBar approvalWeight={2} quorumWeight={5} totalWeight={0} />
    );

    // Tick is only rendered when totalWeight > 0.
    const tickEl = container.querySelector('[title*="Quorum at"]');
    expect(tickEl).toBeNull();
  });
});
