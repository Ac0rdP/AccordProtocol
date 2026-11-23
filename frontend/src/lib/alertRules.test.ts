import { describe, expect, it } from "vitest";
import { describeRule, draftToInput, emptyDraft, ruleToDraft, validateDraft, type AlertRule } from "./alertRules";

describe("alert rule drafts", () => {
  it("validates each rule type", () => {
    expect(validateDraft(emptyDraft("spend_threshold"))).toMatchObject({ id: expect.any(String), threshold: expect.any(String) });
    const burst = { ...emptyDraft("approval_burst"), id: "burst", maxApprovals: "0" };
    expect(validateDraft(burst).maxApprovals).toBeDefined();
    const night = { ...emptyDraft("off_hours_approval"), id: "night", startHour: "5", endHour: "5" };
    expect(validateDraft(night).endHour).toBeDefined();
    expect(validateDraft({ ...night, endHour: "6" })).toEqual({});
    expect(validateDraft({ ...emptyDraft(), id: "test", threshold: "1" }).id).toMatch(/reserved/);
  });

  it("builds the API body in seconds and round-trips through a rule", () => {
    const draft = { ...emptyDraft(), id: "big", token: "USDC", threshold: "1000", windowValue: "2", windowUnit: "hours" as const, cooldownMinutes: "15" };
    const input = draftToInput(draft);
    expect(input).toMatchObject({ id: "big", type: "spend_threshold", token: "USDC", threshold: "1000", windowSecs: 7200, cooldownSecs: 900 });

    const rule: AlertRule = { ...input, id: "big", type: "spend_threshold", severity: "warning", category: "threshold", source: "managed", enabled: true };
    expect(ruleToDraft(rule)).toMatchObject({ windowValue: "2", windowUnit: "hours", cooldownMinutes: "15" });
    expect(describeRule(rule)).toBe("USDC spend reaches 1000 within 2 hours");
  });
});
