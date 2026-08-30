import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { ApprovalBar } from "./ApprovalBar";

describe("ApprovalBar", () => {
  test("shows quorum completion for a single owner holding all voting weight", () => {
    render(
      <ApprovalBar approvalWeight={100} quorumWeight={100} totalWeight={100} />,
    );

    expect(screen.getByLabelText(/100 percent of quorum achieved/)).toBeInTheDocument();
    expect(screen.getByText("100 / 100 weight")).toBeInTheDocument();
    expect(screen.queryByText(/NaN/i)).not.toBeInTheDocument();
  });
});
