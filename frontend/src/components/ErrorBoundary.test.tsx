import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

function Boom(): React.ReactElement {
  throw new Error("boom");
}

describe("ErrorBoundary", () => {
  const consoleError = console.error;

  beforeEach(() => {
    // React logs the caught error; keep the test output clean.
    console.error = vi.fn();
  });

  afterEach(() => {
    console.error = consoleError;
  });

  it("renders its children when nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>All good</p>
      </ErrorBoundary>,
    );

    expect(screen.getByText("All good")).toBeDefined();
  });

  it("renders the error state and reports the error when a child throws", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Something went wrong.")).toBeDefined();
    expect(screen.getByRole("button", { name: /retry/i })).toBeDefined();
    expect(console.error).toHaveBeenCalled();
  });
});
