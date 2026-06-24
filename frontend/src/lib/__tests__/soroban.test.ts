import { expect, test, describe } from "vitest";
import { stroopsToDisplay, displayToStroops, contractErrorMessage } from "../soroban";

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
