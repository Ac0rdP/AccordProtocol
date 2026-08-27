import { expect, test, describe } from "vitest";
import {
  stroopsToDisplay,
  displayToStroops,
  weightToPercent,
  formatWeightPercent,
  contractErrorMessage,
  formatDeadline,
  shortenAddr,
  formatInterval,
  formatCountdown,
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
  test("all 25 contract codes return messages", () => {
    expect(contractErrorMessage("Error(Contract,#1)")).toContain("initialized");
    expect(contractErrorMessage("Error(Contract,#2)")).toContain("initialized");
    expect(contractErrorMessage("Error(Contract,#3)")).toContain("Unauthorized");
    expect(contractErrorMessage("Error(Contract,#4)")).toContain("Invalid threshold");
    expect(contractErrorMessage("Error(Contract,#5)")).toContain("owners");
    expect(contractErrorMessage("Error(Contract,#6)")).toContain("Proposal not found");
    expect(contractErrorMessage("Error(Contract,#7)")).toContain("active");
    expect(contractErrorMessage("Error(Contract,#8)")).toContain("already approved");
    expect(contractErrorMessage("Error(Contract,#9)")).toContain("not approved");
    expect(contractErrorMessage("Error(Contract,#10)")).toContain("threshold");
    expect(contractErrorMessage("Error(Contract,#11)")).toContain("expired");
    expect(contractErrorMessage("Error(Contract,#12)")).toContain("Invalid amount");
    expect(contractErrorMessage("Error(Contract,#13)")).toContain("deadline");
    expect(contractErrorMessage("Error(Contract,#14)")).toContain("token");
    expect(contractErrorMessage("Error(Contract,#15)")).toContain("transfer failed");
    expect(contractErrorMessage("Error(Contract,#16)")).toContain("empty");
    expect(contractErrorMessage("Error(Contract,#17)")).toContain("too long");
    expect(contractErrorMessage("Error(Contract,#18)")).toContain("Too many");
    expect(contractErrorMessage("Error(Contract,#19)")).toContain("Duplicate");
    expect(contractErrorMessage("Error(Contract,#20)")).toContain("Arithmetic");
    expect(contractErrorMessage("Error(Contract,#21)")).toContain("Invalid duration");
    expect(contractErrorMessage("Error(Contract,#22)")).toContain("recipient");
    expect(contractErrorMessage("Error(Contract,#23)")).toContain("Time lock");
    expect(contractErrorMessage("Error(Contract,#24)")).toContain("break the required threshold");
    expect(contractErrorMessage("Error(Contract,#25)")).toContain("Owner not found");
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

describe("formatInterval", () => {
  test("returns 'Daily' for 86400 seconds", () => {
    expect(formatInterval(86400)).toBe("Daily");
  });

  test("returns 'Weekly' for 604800 seconds", () => {
    expect(formatInterval(604800)).toBe("Weekly");
  });

  test("returns 'Monthly' for 2592000 seconds", () => {
    expect(formatInterval(2592000)).toBe("Monthly");
  });

  test("returns 'Yearly' for 31536000 seconds", () => {
    expect(formatInterval(31536000)).toBe("Yearly");
  });

  test("returns 'Every N days' for day multiples", () => {
    expect(formatInterval(172800)).toBe("Every 2 days");
  });

  test("returns 'Every N hours' for hour multiples", () => {
    expect(formatInterval(7200)).toBe("Every 2 hours");
  });

  test("returns 'Every N mins' for minute multiples", () => {
    expect(formatInterval(180)).toBe("Every 3 mins");
  });

  test("returns 'Every Ns' for sub-minute intervals", () => {
    expect(formatInterval(45)).toBe("Every 45s");
  });

  test("returns dash for zero or negative", () => {
    expect(formatInterval(0)).toBe("—");
    expect(formatInterval(-5)).toBe("—");
  });

  test("handles bigint input", () => {
    expect(formatInterval(86400n)).toBe("Daily");
  });

  test("handles string input", () => {
    expect(formatInterval("604800")).toBe("Weekly");
  });
});

describe("formatCountdown", () => {
  test("returns 'Due now' for past timestamps", () => {
    expect(formatCountdown(Date.now() - 1000)).toBe("Due now");
  });

  test("returns 'Due now' for exactly now", () => {
    expect(formatCountdown(Date.now())).toBe("Due now");
  });

  test("returns days and hours for far future", () => {
    const target = Date.now() + 4 * 86400 * 1000 + 3 * 3600 * 1000;
    expect(formatCountdown(target)).toMatch(/^next in 4d 3h$/);
  });

  test("returns hours and minutes for hours ahead", () => {
    const target = Date.now() + 2 * 3600 * 1000 + 30 * 60 * 1000;
    expect(formatCountdown(target)).toMatch(/^next in 2h 30m$/);
  });

  test("returns minutes for minutes ahead", () => {
    const target = Date.now() + 15 * 60 * 1000;
    expect(formatCountdown(target)).toMatch(/^next in 15m$/);
  });

  test("returns '<1m' for less than a minute", () => {
    const target = Date.now() + 30 * 1000;
    expect(formatCountdown(target)).toBe("next in <1m");
  });
});
