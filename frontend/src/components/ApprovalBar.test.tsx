import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, test, expect } from "vitest";
import { ApprovalBar } from "./ApprovalBar";

// ApprovalBar measures progress against the snapshotted quorumWeight, not the
// live totalWeight. These tests pin that invariant under weight drift.

describe("ApprovalBar", () => {
  test("shows quorum completion for a single owner holding all voting weight", () => {
    render(
      <ApprovalBar approvalWeight={100} quorumWeight={100} totalWeight={100} />,
    );

    expect(screen.getByLabelText("100 / 100 weight")).toBeInTheDocument();
    expect(screen.getByText("100 / 100 weight")).toBeInTheDocument();
    expect(screen.queryByText(/NaN/i)).not.toBeInTheDocument();
  });

  test("renders the snapshotted quorum in the weight label", () => {
    render(
      <ApprovalBar approvalWeight={7} quorumWeight={10} totalWeight={35} />,
    );

    expect(screen.getByText("7 / 10 weight")).toBeTruthy();
  });

  test("aria-label reflects snapshotted quorum weight", () => {
    const { container } = render(
      <ApprovalBar approvalWeight={5} quorumWeight={10} totalWeight={20} />,
    );

    const wrapper = container.firstChild as HTMLElement;
    const label = wrapper.getAttribute("aria-label") ?? "";

    expect(label).toBe("5 / 10 weight");
  });

  test("progress label uses snapshotted quorum when approval meets it", () => {
    render(
      <ApprovalBar approvalWeight={10} quorumWeight={10} totalWeight={50} />,
    );

    expect(screen.getByText("10 / 10 weight")).toBeTruthy();
  });

  test("progress label is not rewritten when approval exceeds quorum", () => {
    render(
      <ApprovalBar approvalWeight={15} quorumWeight={10} totalWeight={30} />,
    );

    expect(screen.getByText("15 / 10 weight")).toBeTruthy();
  });

  test("snapshot smaller than live total still labels against quorum", () => {
    render(
      <ApprovalBar approvalWeight={4} quorumWeight={8} totalWeight={16} />,
    );

    expect(screen.getByText("4 / 8 weight")).toBeTruthy();
    expect(screen.getByLabelText("4 / 8 weight")).toBeInTheDocument();
  });

  test("snapshot larger mismatch: live total doubled but quorum label unchanged", () => {
    render(
      <ApprovalBar approvalWeight={3} quorumWeight={5} totalWeight={40} />,
    );

    expect(screen.getByText("3 / 5 weight")).toBeTruthy();
  });

  test("zero quorumWeight is handled gracefully", () => {
    render(
      <ApprovalBar approvalWeight={0} quorumWeight={0} totalWeight={10} />,
    );

    expect(screen.getByText("0 / 0 weight")).toBeTruthy();
  });

  test("zero totalWeight still renders the weight label", () => {
    render(
      <ApprovalBar approvalWeight={2} quorumWeight={5} totalWeight={0} />,
    );

    expect(screen.getByText("2 / 5 weight")).toBeTruthy();
  });
});
