import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  test("renders title and description", () => {
    render(
      <EmptyState
        title="No active proposals"
        description="Proposals let signers vote on transactions before they execute."
      />,
    );
    expect(screen.getByText("No active proposals")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Proposals let signers vote on transactions before they execute.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  test("renders optional action", () => {
    const onClick = vi.fn();
    render(
      <EmptyState
        title="Empty"
        action={
          <button type="button" onClick={onClick}>
            Create proposal
          </button>
        }
      />,
    );
    expect(
      screen.getByRole("button", { name: "Create proposal" }),
    ).toBeInTheDocument();
  });
});
