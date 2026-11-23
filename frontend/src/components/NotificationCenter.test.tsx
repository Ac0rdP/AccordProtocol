import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotificationCenter } from "./NotificationCenter";

const state = vi.hoisted(() => ({
  notifications: [] as Array<{
    id: string;
    type: string;
    title: string;
    body: string;
    createdAt: string;
    read: boolean;
  }>,
  markRead: vi.fn(),
  markAllRead: vi.fn(),
}));

vi.mock("../hooks/useNotificationCenter", () => ({
  useNotificationCenter: () => ({
    notifications: state.notifications,
    unreadCount: state.notifications.filter((n) => !n.read).length,
    markRead: state.markRead,
    markAllRead: state.markAllRead,
  }),
}));

function notification(id: string, read: boolean) {
  return {
    id,
    type: "proposal_created",
    title: `Proposal ${id}`,
    body: `Body ${id}`,
    createdAt: "2026-06-27T12:00:00Z",
    read,
  };
}

function installStorage() {
  const store: Record<string, string> = {};
  const mock = {
    getItem: (key: string) => (key in store ? store[key] : null),
    setItem: (key: string, value: string) => {
      store[key] = String(value);
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      for (const key of Object.keys(store)) delete store[key];
    },
  };
  Object.defineProperty(window, "localStorage", { value: mock, writable: true, configurable: true });
  Object.defineProperty(globalThis, "localStorage", { value: mock, writable: true, configurable: true });
}

describe("NotificationCenter", () => {
  beforeEach(() => {
    installStorage();
    state.notifications = [];
    state.markRead.mockClear();
    state.markAllRead.mockClear();
  });

  it("shows an unread badge and the empty state", () => {
    state.notifications = [notification("1", false), notification("2", false)];
    render(<NotificationCenter />);

    expect(screen.getByTestId("notification-unread-badge").textContent).toBe("2");
    expect(screen.getByRole("button", { name: /Notifications/ }).getAttribute("aria-expanded")).toBe(
      "false",
    );

    fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));
    expect(screen.getByText("Proposal 1")).toBeDefined();
    expect(screen.getByText("Proposal 2")).toBeDefined();
  });

  it("caps the badge at 99+", () => {
    state.notifications = Array.from({ length: 120 }, (_, i) => notification(String(i), false));
    render(<NotificationCenter />);

    expect(screen.getByTestId("notification-unread-badge").textContent).toBe("99+");
    expect(screen.getByRole("button", { name: /120 unread/ })).toBeDefined();
  });

  it("marks a notification read and marks all as read", () => {
    state.notifications = [notification("1", false), notification("2", true)];
    render(<NotificationCenter />);

    fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));
    fireEvent.click(screen.getByText("Proposal 1"));
    expect(state.markRead).toHaveBeenCalledWith("1");

    fireEvent.click(screen.getByText("Mark all read"));
    expect(state.markAllRead).toHaveBeenCalledTimes(1);
  });

  it("toggles notification preferences", () => {
    render(<NotificationCenter />);

    fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));
    fireEvent.click(screen.getByText("Preferences"));

    const created = screen.getByRole("checkbox", { name: "Proposal created" }) as HTMLInputElement;
    expect(created.checked).toBe(true);

    fireEvent.click(created);
    expect((screen.getByRole("checkbox", { name: "Proposal created" }) as HTMLInputElement).checked).toBe(
      false,
    );
    expect(JSON.parse(localStorage.getItem("accord_notification_preferences") ?? "{}")).toMatchObject({
      proposal_created: false,
    });

    fireEvent.click(screen.getByText("Done"));
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("closes when clicking outside", () => {
    render(<NotificationCenter />);

    fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));
    expect(screen.getByText("No notifications yet.")).toBeDefined();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByText("No notifications yet.")).toBeNull();
  });
});
