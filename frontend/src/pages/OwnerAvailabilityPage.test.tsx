import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OwnerAvailabilityPage } from "./OwnerAvailabilityPage";
import { sampleOwners } from "../stories/fixtures";

const NOW = Date.UTC(2026, 10, 19, 12);

beforeEach(() => localStorage.clear());

describe("OwnerAvailabilityPage", () => {
  it("shows the loading state while contract data loads", () => {
    render(<OwnerAvailabilityPage owners={[]} proposals={[]} loading now={NOW} />);
    expect(screen.getByText("Loading owner availability…")).toBeInTheDocument();
  });

  it("shows the contract error with retry", async () => {
    const onRetry = vi.fn();
    render(
      <OwnerAvailabilityPage owners={sampleOwners} proposals={[]} error="RPC down" onRetry={onRetry} now={NOW} />,
    );
    expect(screen.getByText("Could not load owner availability")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("shows the empty state with no owners", () => {
    render(<OwnerAvailabilityPage owners={[]} proposals={[]} now={NOW} />);
    expect(screen.getByText("No owners to schedule")).toBeInTheDocument();
  });

  it("surfaces corrupted saved availability and lets the user reset it", async () => {
    localStorage.setItem("accord_owner_availability", "{broken");
    const user = userEvent.setup();
    render(<OwnerAvailabilityPage owners={sampleOwners} proposals={[]} now={NOW} />);

    expect(screen.getByRole("alert")).toHaveTextContent("Could not load owner availability");
    await user.click(screen.getByRole("button", { name: "Reset saved availability" }));
    expect(screen.getByRole("list", { name: "Alice availability this week" })).toBeInTheDocument();
  });

  it("persists edits across remounts", async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <OwnerAvailabilityPage owners={sampleOwners} proposals={[]} now={NOW} />,
    );
    await user.click(screen.getByRole("button", { name: "Edit availability for Bob" }));
    await user.click(screen.getByRole("checkbox", { name: "Sunday" }));
    await user.click(screen.getByRole("button", { name: "Save hours" }));
    unmount();

    render(<OwnerAvailabilityPage owners={sampleOwners} proposals={[]} now={NOW} />);
    expect(screen.getByText(/sunday, november 22: available 09:00 to 17:00 utc/i)).toBeInTheDocument();
    expect(screen.queryByText(/Weight 12 · default hours/)).not.toBeInTheDocument();
  });
});
