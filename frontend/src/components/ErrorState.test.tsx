import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { ErrorState } from "./ErrorState";

describe("ErrorState", () => {
  test("renders error message with alert role", () => {
    render(<ErrorState message="Failed to load contract data" />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Failed to load contract data",
    );
  });

  test("invokes onRetry when Retry is clicked", () => {
    const onRetry = vi.fn();
    render(
      <ErrorState message="Something went wrong" onRetry={onRetry} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test("banner variant exposes dismiss control", () => {
    const onDismiss = vi.fn();
    render(
      <ErrorState
        message="Network error"
        variant="banner"
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
