import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { describe, expect, it, vi } from "vitest";
import { OwnerAvailabilityCalendar } from "./OwnerAvailabilityCalendar";
import { baseProposal } from "../stories/fixtures";
import type { Owner } from "../types/accord";
import type { AvailabilityMap } from "../lib/ownerAvailability";
import { ACCEPTANCE_VIEWPORTS, setViewport } from "../test/viewport";

// Thursday 2026-11-19 12:00 UTC
const NOW = Date.UTC(2026, 10, 19, 12);
const HOUR = 3_600_000;

const owners: Owner[] = [
  { address: "GAAA…0001", fullAddress: "GAAA0001", label: "Alice", roles: ["Owner"], weight: 2 },
  { address: "GBBB…0002", fullAddress: "GBBB0002", label: "Bob", roles: ["Owner"], weight: 3 },
];

function setup(overrides: Partial<React.ComponentProps<typeof OwnerAvailabilityCalendar>> = {}) {
  const props = {
    owners,
    proposals: [],
    availability: {} as AvailabilityMap,
    onSaveAvailability: vi.fn(),
    now: NOW,
    ...overrides,
  };
  const user = userEvent.setup();
  const utils = render(<OwnerAvailabilityCalendar {...props} />);
  return { user, props, ...utils };
}

describe("OwnerAvailabilityCalendar", () => {
  it("renders the current UTC week with each owner's hours", () => {
    setup({ availability: { GBBB0002: [{ day: 6, start: 10, end: 14 }] } });
    expect(screen.getByRole("heading", { name: /week of nov 16 – nov 22, 2026/i })).toBeInTheDocument();

    const alice = screen.getByRole("list", { name: "Alice availability this week" });
    expect(within(alice).getByText(/thursday, november 19 \(today\): available 09:00 to 17:00 utc/i)).toBeInTheDocument();
    expect(within(alice).getByText(/saturday, november 21: unavailable/i)).toBeInTheDocument();

    const bob = screen.getByRole("list", { name: "Bob availability this week" });
    expect(within(bob).getByText(/saturday, november 21: available 10:00 to 14:00 utc/i)).toBeInTheDocument();
    expect(screen.getByText(/Weight 2 · default hours/)).toBeInTheDocument();
  });

  it("navigates between weeks", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Next week" }));
    expect(screen.getByRole("heading", { name: /week of nov 23/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "This week" }));
    expect(screen.getByRole("heading", { name: /week of nov 16/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "This week" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Previous week" }));
    expect(screen.getByRole("heading", { name: /week of nov 9/i })).toBeInTheDocument();
  });

  it("shows a four-week rotation with primary and backup, and badges this week's owners", () => {
    setup();
    const rotation = screen.getByRole("heading", { name: "Approval rotation" }).closest("section")!;
    expect(within(rotation).getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getAllByText("On rotation")).toHaveLength(1);
    expect(screen.getAllByText("Backup")).toHaveLength(1);
  });

  it("suggests coverage for time-sensitive proposals and warns when quorum is unreachable", () => {
    const deadline = (h: number) => Math.floor((NOW + h * HOUR) / 1000);
    setup({
      proposals: [
        baseProposal({ id: 7, description: "Urgent payout", deadlineTs: deadline(6), quorumWeight: 3, approvalWeight: 0, approverAddresses: [] }),
        baseProposal({ id: 8, description: "Impossible", deadlineTs: deadline(3), quorumWeight: 50, approvalWeight: 0, approverAddresses: [] }),
        baseProposal({ id: 9, description: "Far away", deadlineTs: deadline(200) }),
      ],
    });
    const urgent = screen.getByText(/#7 · Urgent payout/).closest("li")!;
    expect(within(urgent).getByText(/Needs 3 more approval weight/)).toBeInTheDocument();
    expect(within(urgent).getByText(/Bob · weight 3 · available now/)).toBeInTheDocument();
    expect(within(urgent).queryByRole("alert")).not.toBeInTheDocument();

    const impossible = screen.getByText(/#8 · Impossible/).closest("li")!;
    expect(within(impossible).getByRole("alert")).toHaveTextContent(/not enough owners/i);
    expect(screen.queryByText(/Far away/)).not.toBeInTheDocument();
  });

  it("shows an empty state when nothing is time-sensitive", () => {
    setup();
    expect(screen.getByText("No time-sensitive proposals")).toBeInTheDocument();
  });

  describe("editing availability", () => {
    it("saves edited hours and announces it", async () => {
      const { user, props } = setup();
      await user.click(screen.getByRole("button", { name: "Edit availability for Alice" }));
      const dialog = screen.getByRole("dialog", { name: "Availability for Alice" });

      await user.click(within(dialog).getByRole("checkbox", { name: "Friday" }));
      await user.click(within(dialog).getByRole("checkbox", { name: "Saturday" }));
      await user.selectOptions(within(dialog).getByLabelText("Saturday start time"), "10");
      await user.selectOptions(within(dialog).getByLabelText("Saturday end time"), "12");
      await user.click(within(dialog).getByRole("button", { name: "Save hours" }));

      expect(props.onSaveAvailability).toHaveBeenCalledWith("GAAA0001", [
        { day: 1, start: 9, end: 17 },
        { day: 2, start: 9, end: 17 },
        { day: 3, start: 9, end: 17 },
        { day: 4, start: 9, end: 17 },
        { day: 6, start: 10, end: 12 },
      ]);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByText("Saved availability for Alice.")).toHaveAttribute("role", "status");
    });

    it("validates that end is after start", async () => {
      const { user, props } = setup();
      await user.click(screen.getByRole("button", { name: "Edit availability for Bob" }));
      await user.selectOptions(screen.getByLabelText("Monday start time"), "18");
      await user.click(screen.getByRole("button", { name: "Save hours" }));
      expect(screen.getByRole("alert")).toHaveTextContent("Monday: end time must be after start time");
      expect(props.onSaveAvailability).not.toHaveBeenCalled();
    });

    it("shows save failures inside the dialog", async () => {
      const onSaveAvailability = vi.fn(() => {
        throw new Error("Could not save availability. Browser storage is unavailable.");
      });
      const { user } = setup({ onSaveAvailability });
      await user.click(screen.getByRole("button", { name: "Edit availability for Bob" }));
      await user.click(screen.getByRole("button", { name: "Save hours" }));
      expect(screen.getByRole("alert")).toHaveTextContent("Browser storage is unavailable");
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
  });

  it.each(ACCEPTANCE_VIEWPORTS)("edits hours with the keyboard only at %ipx", async (width) => {
    setViewport(width);
    const { user, props } = setup();

    const trigger = screen.getByRole("button", { name: "Edit availability for Alice" });
    trigger.focus();
    await user.keyboard("{Enter}");
    const monday = screen.getByRole("checkbox", { name: "Monday" });
    expect(monday).toHaveFocus();
    await user.keyboard(" "); // turn Monday off

    // Shift+Tab from the first control wraps to Save (focus trap).
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Save hours" })).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(props.onSaveAvailability).toHaveBeenCalledWith(
      "GAAA0001",
      expect.not.arrayContaining([expect.objectContaining({ day: 1 })]),
    );
    expect(trigger).toHaveFocus();

    // Escape closes without saving.
    await user.keyboard("{Enter}");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(props.onSaveAvailability).toHaveBeenCalledTimes(1);
  });

  it("has no axe violations in the calendar or the editor", async () => {
    const { user, container } = setup({
      proposals: [baseProposal({ deadlineTs: Math.floor((NOW + 5 * HOUR) / 1000) })],
    });
    expect((await axe(container)).violations).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Edit availability for Alice" }));
    expect((await axe(container)).violations).toEqual([]);
  });
});
