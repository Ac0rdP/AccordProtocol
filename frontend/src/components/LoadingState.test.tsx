import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { LoadingState } from "./LoadingState";

describe("LoadingState", () => {
  test("renders default loading message with status role", () => {
    render(<LoadingState />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  test("renders a custom message", () => {
    render(<LoadingState message="Loading contract data…" />);
    expect(screen.getByText("Loading contract data…")).toBeInTheDocument();
  });
});
