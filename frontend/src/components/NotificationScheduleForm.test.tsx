import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { describe, expect, it, vi } from "vitest";
import { NotificationScheduleForm } from "./NotificationScheduleForm";
import {
  DEFAULT_NOTIFICATION_SCHEDULE,
  type DigestItem,
  type NotificationSchedule,
} from "../lib/notificationSchedule";
import { ACCEPTANCE_VIEWPORTS, setViewport } from "../test/viewport";

const NOW = new Date(2026, 10, 19, 12).getTime(); // Thursday, local time

const queued: DigestItem[] = [
  {
    id: "a",
    type: "proposal_ready",
    title: "Proposal Ready",
    body: "Proposal #4 has reached quorum and is ready to execute.",
    createdAt: new Date(2026, 10, 19, 23).toISOString(),
    reason: "quiet",
  },
];

function setup(overrides: Partial<React.ComponentProps<typeof NotificationScheduleForm>> = {}) {
  const props = {
    schedule: DEFAULT_NOTIFICATION_SCHEDULE,
    onSave: vi.fn(),
    queue: [] as DigestItem[],
    onClearQueue: vi.fn(),
    now: NOW,
    ...overrides,
  };
  const user = userEvent.setup();
  const utils = render(<NotificationScheduleForm {...props} />);
  return { user, props, ...utils };
}

describe("NotificationScheduleForm", () => {
  it("starts with quiet hours and digest inputs disabled by default", () => {
    setup();
    expect(screen.getByLabelText("Start")).toBeDisabled();
    expect(screen.getByLabelText("Delivery time")).toBeDisabled();
    expect(screen.getByLabelText("Weekly on")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save schedule" })).toBeDisabled();
  });

  it("saves quiet hours and a weekly digest", async () => {
    const { user, props } = setup();
    await user.click(screen.getByLabelText("Enable quiet hours"));
    await user.clear(screen.getByLabelText("Start"));
    await user.type(screen.getByLabelText("Start"), "21:30");
    await user.click(screen.getByRole("radio", { name: /weekly/i }));
    await user.selectOptions(screen.getByLabelText("Weekly on"), "Friday");
    expect(screen.getByText(/Next digest:/)).toHaveTextContent(/Fri/);

    await user.click(screen.getByRole("button", { name: "Save schedule" }));
    const saved: NotificationSchedule = props.onSave.mock.calls[0][0];
    expect(saved).toEqual({
      quietHours: { enabled: true, start: "21:30", end: "07:00" },
      digest: { frequency: "weekly", time: "09:00", weekday: 5 },
    });
    expect(screen.getByText("Notification schedule saved.")).toHaveAttribute("role", "status");
  });

  it("validates before saving", async () => {
    const { user, props } = setup();
    await user.click(screen.getByLabelText("Enable quiet hours"));
    await user.clear(screen.getByLabelText("End"));
    await user.type(screen.getByLabelText("End"), "22:00");
    await user.click(screen.getByRole("button", { name: "Save schedule" }));
    expect(screen.getByRole("alert")).toHaveTextContent("different times");
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it("shows save errors", async () => {
    const onSave = vi.fn(() => {
      throw new Error("Could not save your schedule. Browser storage is unavailable.");
    });
    const { user } = setup({ onSave });
    await user.click(screen.getByRole("radio", { name: /daily/i }));
    await user.click(screen.getByRole("button", { name: "Save schedule" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Browser storage is unavailable");
  });

  it("discards unsaved changes", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("radio", { name: /daily/i }));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.getByRole("radio", { name: /off/i })).toBeChecked();
  });

  it("shows an empty queue state", () => {
    setup();
    expect(screen.getByText("No alerts waiting")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Waiting to be sent (0)" })).toBeInTheDocument();
  });

  it("lists queued alerts and lets the user discard them", async () => {
    const { user, props } = setup({ queue: queued });
    expect(screen.getByText(queued[0].body)).toBeInTheDocument();
    expect(screen.getByText(/Held for quiet hours/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Discard queued alerts" }));
    expect(props.onClearQueue).toHaveBeenCalled();
  });

  it.each(ACCEPTANCE_VIEWPORTS)("configures a daily digest with the keyboard only at %ipx", async (width) => {
    setViewport(width);
    const { user, props } = setup();

    await user.tab();
    expect(screen.getByLabelText("Enable quiet hours")).toHaveFocus();
    await user.keyboard(" ");
    await user.tab(); // start
    await user.tab(); // end
    await user.tab(); // digest radio group (Off is checked)
    expect(screen.getByRole("radio", { name: /off/i })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: /daily/i })).toBeChecked();
    await user.tab(); // delivery time
    await user.tab(); // Discard (weekday select is disabled)
    await user.tab(); // Save
    expect(screen.getByRole("button", { name: "Save schedule" })).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(props.onSave).toHaveBeenCalledWith({
      quietHours: { enabled: true, start: "22:00", end: "07:00" },
      digest: { frequency: "daily", time: "09:00", weekday: 1 },
    });
  });

  it("has no axe violations", async () => {
    const { container } = setup({ queue: queued });
    expect((await axe(container)).violations).toEqual([]);
  });
});
