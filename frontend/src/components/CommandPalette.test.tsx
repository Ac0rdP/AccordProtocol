import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CommandPalette } from "./CommandPalette";
import type { Command } from "../lib/commandPalette";

function makeCommands() {
  const navigate = vi.fn();
  const action = vi.fn();
  const commands: Command[] = [
    {
      id: "dashboard",
      title: "Dashboard",
      subtitle: "Treasury overview",
      group: "navigate",
      keywords: ["home", "overview"],
      shortcut: "G D",
      perform: navigate,
    },
    {
      id: "new-proposal",
      title: "New Proposal",
      group: "action",
      perform: action,
    },
  ];
  return { commands, navigate, action };
}

function openPalette() {
  fireEvent.keyDown(window, { key: "p", shiftKey: true, metaKey: true });
}

describe("CommandPalette", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens with the keyboard shortcut and renders grouped commands", () => {
    const { commands } = makeCommands();
    render(<CommandPalette commands={commands} />);

    expect(screen.queryByRole("dialog")).toBeNull();

    openPalette();

    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeDefined();
    expect(screen.getByText("Navigate")).toBeDefined();
    expect(screen.getByText("Actions")).toBeDefined();
    expect(screen.getByText("Dashboard")).toBeDefined();
    expect(screen.getByText("Treasury overview")).toBeDefined();
    expect(screen.getByText("G D")).toBeDefined();
  });

  it("filters by title and keywords and shows an empty state", () => {
    const { commands } = makeCommands();
    render(<CommandPalette commands={commands} />);
    openPalette();

    const input = screen.getByRole("combobox");

    fireEvent.change(input, { target: { value: "home" } });
    expect(screen.getByText("Dashboard")).toBeDefined();
    expect(screen.queryByText("New Proposal")).toBeNull();

    fireEvent.change(input, { target: { value: "zzz" } });
    expect(screen.getByText("No matching commands.")).toBeDefined();
  });

  it("navigates with arrow keys and runs the active command on Enter", () => {
    const { commands, action } = makeCommands();
    render(<CommandPalette commands={commands} />);
    openPalette();

    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(action).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("runs a command when it is clicked", () => {
    const { commands, navigate } = makeCommands();
    render(<CommandPalette commands={commands} />);
    openPalette();

    fireEvent.click(screen.getByText("Dashboard"));

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on Escape and when the backdrop is clicked", () => {
    const { commands } = makeCommands();
    render(<CommandPalette commands={commands} />);
    openPalette();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    openPalette();
    const backdrop = screen.getByRole("dialog").parentElement!;
    fireEvent.mouseDown(backdrop);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not open while suspended or while typing in a field", () => {
    const { commands } = makeCommands();
    const { rerender } = render(<CommandPalette commands={commands} suspended />);

    openPalette();
    expect(screen.queryByRole("dialog")).toBeNull();

    rerender(<CommandPalette commands={commands} />);
    const field = document.createElement("input");
    document.body.appendChild(field);
    fireEvent.keyDown(field, { key: "/" });
    expect(screen.queryByRole("dialog")).toBeNull();
    field.remove();

    fireEvent.keyDown(window, { key: "/" });
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeDefined();
  });
});
