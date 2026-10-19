import { expect, test, describe } from "vitest";
import {
  canApprove,
  canCreate,
  canExecute,
  contractErrorMessage,
  CONTRACT_ERRORS,
  displayToStroops,
  formatDeadline,
  formatWeightPercent,
  missingRoleTooltip,
  shortenAddr,
  stroopsToDisplay,
  weightToPercent,
} from "../soroban";

describe("stroopsToDisplay", () => {
  test("zero", () => {
    expect(stroopsToDisplay(0n)).toBe("0");
  });

  test("whole values", () => {
    expect(stroopsToDisplay(10000000n)).toBe("1");
    expect(stroopsToDisplay(50000000n)).toBe("5");
    expect(stroopsToDisplay(100000000n)).toBe("10");
  });

  test("decimals", () => {
    expect(stroopsToDisplay(15000000n)).toBe("1.5");
    expect(stroopsToDisplay(10000n)).toBe("0.001");
    expect(stroopsToDisplay(12345678n)).toBe("1.2345678");
  });

  test("large values", () => {
    expect(stroopsToDisplay(10000000000000000n)).toBe("1000000000");
  });
});

describe("displayToStroops", () => {
  test("integer conversion", () => {
    expect(displayToStroops(1)).toBe(10000000n);
    expect(displayToStroops(0)).toBe(0n);
    expect(displayToStroops(5)).toBe(50000000n);
  });

  test("decimal conversion", () => {
    expect(displayToStroops(1.5)).toBe(15000000n);
    expect(displayToStroops(0.001)).toBe(10000n);
    expect(displayToStroops(1.2345678)).toBe(12345678n);
  });

  test("large values", () => {
    expect(displayToStroops(1000000000)).toBe(10000000000000000n);
  });
});

describe("weightToPercent", () => {
  test("returns the owner share for a normal weight", () => {
    expect(weightToPercent(5, 20)).toBe(25);
  });

  test("returns zero for a zero-weight owner", () => {
    expect(weightToPercent(0, 20)).toBe(0);
  });

  test("returns 100 for a single-owner total", () => {
    expect(weightToPercent(7, 7)).toBe(100);
  });

  test("returns zero when total weight is zero", () => {
    expect(weightToPercent(5, 0)).toBe(0);
  });
});

describe("formatWeightPercent", () => {
  test("formats a normal weight share with one decimal place", () => {
    expect(formatWeightPercent(5, 20)).toBe("25.0%");
  });

  test("formats a zero-weight owner", () => {
    expect(formatWeightPercent(0, 20)).toBe("0.0%");
  });

  test("formats a 100-percent single-owner share", () => {
    expect(formatWeightPercent(7, 7)).toBe("100.0%");
  });

  test("formats zero when total weight is zero", () => {
    expect(formatWeightPercent(5, 0)).toBe("0.0%");
  });
});

describe("contractErrorMessage", () => {
  test("all 57 contract codes return specific user-facing messages", () => {
    for (let code = 1; code <= 57; code++) {
      const msg = contractErrorMessage(`Error(Contract,#${code})`);
      expect(msg).not.toBe("Something went wrong while processing the transaction. Please try again.");
      expect(msg.length).toBeGreaterThan(5);
    }
  });

  test("CONTRACT_ERRORS covers every code from 1 to 57 without gaps", () => {
    for (let code = 1; code <= 57; code++) {
      const key = String(code);
      expect(CONTRACT_ERRORS[key], `Contract error code #${code} must be mapped in CONTRACT_ERRORS`).toBeDefined();
      expect(typeof CONTRACT_ERRORS[key]).toBe("string");
      expect(CONTRACT_ERRORS[key].length).toBeGreaterThan(0);
    }
  });

  test("newly added error variants (35-57) map to expected domain messaging", () => {
    expect(contractErrorMessage("Error(Contract,#35)")).toContain("Recurring payment is inactive");
    expect(contractErrorMessage("Error(Contract,#36)")).toContain("Recurring payment interval");
    expect(contractErrorMessage("Error(Contract,#37)")).toContain("Too many active recurring");
    expect(contractErrorMessage("Error(Contract,#38)")).toContain("already cancelled");
    expect(contractErrorMessage("Error(Contract,#39)")).toContain("already paused");
    expect(contractErrorMessage("Error(Contract,#40)")).toContain("not paused");
    expect(contractErrorMessage("Error(Contract,#41)")).toContain("terminal state");
    expect(contractErrorMessage("Error(Contract,#42)")).toContain("Invalid weights list length");
    expect(contractErrorMessage("Error(Contract,#43)")).toContain("below the minimum");
    expect(contractErrorMessage("Error(Contract,#44)")).toContain("Invalid owner weight");
    expect(contractErrorMessage("Error(Contract,#45)")).toContain("already been migrated");
    expect(contractErrorMessage("Error(Contract,#46)")).toContain("weight cap");
    expect(contractErrorMessage("Error(Contract,#47)")).toContain("Target owner no longer exists");
    expect(contractErrorMessage("Error(Contract,#48)")).toContain("break the required quorum");
    expect(contractErrorMessage("Error(Contract,#49)")).toContain("last remaining owner");
    expect(contractErrorMessage("Error(Contract,#50)")).toContain("Threshold exceeds");
    expect(contractErrorMessage("Error(Contract,#51)")).toContain("Recurring schedule is not active");
    expect(contractErrorMessage("Error(Contract,#52)")).toContain("requires a role");
    expect(contractErrorMessage("Error(Contract,#53)")).toContain("Role is already granted");
    expect(contractErrorMessage("Error(Contract,#54)")).toContain("Role is not granted");
    expect(contractErrorMessage("Error(Contract,#55)")).toContain("Specified role is not valid");
    expect(contractErrorMessage("Error(Contract,#56)")).toContain("deprecated");
    expect(contractErrorMessage("Error(Contract,#57)")).toContain("recovery is currently active");
  });

  test("unknown error returns fallback", () => {
    expect(contractErrorMessage("Random error")).toContain("Something went wrong");
    expect(contractErrorMessage("Error(Contract,#99)")).toContain("Something went wrong");
  });

  test("RPC formatted errors parse correctly", () => {
    expect(contractErrorMessage("Error(Contract,#3)")).toContain("Unauthorized");
    expect(contractErrorMessage("Error(Contract, #6)")).toContain("Proposal not found");
  });
});

describe("formatDeadline", () => {
  test("returns human-readable date string for a known Unix timestamp", () => {
    // 2025-01-15 12:00:00 UTC — noon UTC stays Jan 15 across UTC-11..UTC+11
    const result = formatDeadline(1736942400n);
    expect(result).toBe("Jan 15, 2025");
  });

  test("returns a non-empty string for any valid timestamp", () => {
    const result = formatDeadline(1700000000n);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("shortenAddr", () => {
  test("returns six leading characters, ellipsis, four trailing characters", () => {
    const addr = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
    const result = shortenAddr(addr);
    expect(result).toBe("GAAZI4...CCWN");
  });

  test("format is XXXXXX...YYYY for a 56-character Stellar address", () => {
    const addr = "GBTEST12345678901234567890123456789012345678901234WXYZ";
    const result = shortenAddr(addr);
    expect(result).toMatch(/^.{6}\.\.\..{4}$/);
  });
});

describe("permission helpers", () => {
  test("canCreate returns true when Proposer role is present", () => {
    expect(canCreate(["Proposer", "Viewer"])).toBe(true);
  });

  test("canCreate returns false when Proposer role is absent", () => {
    expect(canCreate(["Approver", "Executor"])).toBe(false);
  });

  test("canApprove returns true when Approver role is present", () => {
    expect(canApprove(["Approver", "Viewer"])).toBe(true);
  });

  test("canApprove returns false when Approver role is absent", () => {
    expect(canApprove(["Proposer", "Executor"])).toBe(false);
  });

  test("canExecute returns true when Executor role is present", () => {
    expect(canExecute(["Executor", "Viewer"])).toBe(true);
  });

  test("canExecute returns false when Executor role is absent", () => {
    expect(canExecute(["Proposer", "Approver"])).toBe(false);
  });

  test("missingRoleTooltip returns the correct role requirement message", () => {
    expect(missingRoleTooltip("execute")).toBe(
      "Executing proposals requires the Executor role."
    );
    expect(missingRoleTooltip("create")).toBe(
      "Creating proposals requires the Proposer role."
    );
    expect(missingRoleTooltip("approve")).toBe(
      "Approving proposals requires the Approver role."
    );
  });
});
