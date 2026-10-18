import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThemeControl } from "./ThemeControl";

describe("ThemeControl", () => {
  it("renders light, system, and dark options", () => {
    render(<ThemeControl currentTheme="system" onThemeChange={vi.fn()} />);

    expect(screen.getByRole("radiogroup", { name: "Theme selection" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /light/i })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /system/i })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /dark/i })).toBeTruthy();
  });

  it("indicates the currently selected theme via aria-checked", () => {
    const { rerender } = render(
      <ThemeControl currentTheme="dark" onThemeChange={vi.fn()} />,
    );

    expect(screen.getByRole("radio", { name: /dark/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("radio", { name: /light/i })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByRole("radio", { name: /system/i })).toHaveAttribute(
      "aria-checked",
      "false",
    );

    rerender(<ThemeControl currentTheme="light" onThemeChange={vi.fn()} />);
    expect(screen.getByRole("radio", { name: /light/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("calls onThemeChange when an option is clicked", () => {
    const onThemeChange = vi.fn();
    render(<ThemeControl currentTheme="system" onThemeChange={onThemeChange} />);

    fireEvent.click(screen.getByRole("radio", { name: /light/i }));
    expect(onThemeChange).toHaveBeenCalledWith("light");

    fireEvent.click(screen.getByRole("radio", { name: /dark/i }));
    expect(onThemeChange).toHaveBeenCalledWith("dark");

    fireEvent.click(screen.getByRole("radio", { name: /system/i }));
    expect(onThemeChange).toHaveBeenCalledWith("system");
  });
});
