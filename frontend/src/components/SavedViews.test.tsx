import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { SavedViews } from "./SavedViews";

describe("SavedViews", () => {
  test("saves, applies, and deletes a keyboard-reachable named view", () => {
    const onSave = vi.fn();
    const onApply = vi.fn();
    const onRemove = vi.fn();
    const { rerender } = render(<SavedViews label="History" views={[]} onSave={onSave} onApply={onApply} onRemove={onRemove} />);
    const input = screen.getByLabelText("Name this view");
    fireEvent.change(input, { target: { value: "Ready items" } });
    fireEvent.submit(input.closest("form")!);
    expect(onSave).toHaveBeenCalledWith("Ready items");

    rerender(<SavedViews label="History" views={[{ id: "ready", name: "Ready items", filters: { status: "ready" } }]} onSave={onSave} onApply={onApply} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: "Ready items" }));
    expect(onApply).toHaveBeenCalledWith({ status: "ready" });
    fireEvent.click(screen.getByRole("button", { name: "Delete saved view Ready items" }));
    expect(onRemove).toHaveBeenCalledWith("ready");
  });
});
