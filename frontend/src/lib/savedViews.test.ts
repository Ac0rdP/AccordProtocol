import { beforeEach, describe, expect, test } from "vitest";
import { getSavedViews, removeSavedView, saveView } from "./savedViews";

describe("saved views", () => {
  beforeEach(() => localStorage.clear());

  test("persists, replaces by name, and removes a named filter preset", () => {
    saveView("history", "Executed payroll", { status: "executed" });
    saveView("history", "Executed payroll", { status: "ready" });
    expect(getSavedViews<{ status: string }>("history")).toEqual([
      expect.objectContaining({ name: "Executed payroll", filters: { status: "ready" } }),
    ]);
    const current = getSavedViews("history")[0];
    removeSavedView("history", current.id);
    expect(getSavedViews("history")).toHaveLength(0);
  });
});
