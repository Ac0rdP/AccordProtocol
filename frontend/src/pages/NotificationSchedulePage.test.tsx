import React from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { NotificationSchedulePage } from "./NotificationSchedulePage";
import { enqueueDigestItem, readNotificationSchedule } from "../lib/notificationSchedule";

const NOW = new Date(2026, 10, 19, 12).getTime();

beforeEach(() => localStorage.clear());

describe("NotificationSchedulePage", () => {
  it("shows a loading state, then the form", async () => {
    render(<NotificationSchedulePage now={NOW} />);
    expect(screen.getByText("Loading notification schedule…")).toBeInTheDocument();
    expect(await screen.findByLabelText("Enable quiet hours")).toBeInTheDocument();
    expect(screen.getByText("No alerts waiting")).toBeInTheDocument();
  });

  it("shows an error for a corrupted schedule and recovers via reset", async () => {
    localStorage.setItem("accord_notification_schedule", "{broken");
    const user = userEvent.setup();
    render(<NotificationSchedulePage now={NOW} />);

    expect(await screen.findByText("Could not load notification schedule")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reset to default schedule" }));
    expect(await screen.findByLabelText("Enable quiet hours")).not.toBeChecked();
  });

  it("persists a saved schedule", async () => {
    const user = userEvent.setup();
    render(<NotificationSchedulePage now={NOW} />);
    await user.click(await screen.findByRole("radio", { name: /daily/i }));
    await user.click(screen.getByRole("button", { name: "Save schedule" }));
    expect(readNotificationSchedule().digest.frequency).toBe("daily");
    expect(screen.getByText("Notification schedule saved.")).toBeInTheDocument();
  });

  it("updates the queue live as alerts are held", async () => {
    render(<NotificationSchedulePage now={NOW} />);
    await screen.findByLabelText("Enable quiet hours");
    act(() => {
      enqueueDigestItem({ type: "proposal_executed", title: "Proposal Executed", body: "Proposal #3 has been executed.", reason: "digest" });
    });
    expect(screen.getByRole("heading", { name: "Waiting to be sent (1)" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Discard queued alerts" }));
    expect(screen.getByText("No alerts waiting")).toBeInTheDocument();
  });
});
