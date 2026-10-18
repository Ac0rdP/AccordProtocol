import { describe, expect, it } from "vitest";
import {
  validateAddress,
  validateAddresses,
  validateDeadline,
  validateDescription,
  validatePositiveAmount,
  validateThreshold,
  validateWeight,
} from "../validation.js";
import { AccordValidationError } from "../errors.js";

describe("SDK Validation Routines", () => {
  const validAccount = "GD5JDFYKNL23W2CQOXW6V57JMGDUQMK2M27B2L67MQK7Y65J42B67I7J";
  const validContract = "CD4YAMHZETIO3GTHP4JB3SF2LQFQMZ6MW5FUNCTMXYGOVN6AAXDBQKJS";

  it("accepts valid G... account and C... contract addresses", () => {
    expect(() => validateAddress(validAccount, "account")).not.toThrow();
    expect(() => validateAddress(validContract, "contract")).not.toThrow();
  });

  it("rejects invalid addresses with AccordValidationError", () => {
    expect(() => validateAddress("invalid-addr", "test")).toThrow(AccordValidationError);
    expect(() => validateAddress("", "test")).toThrow(AccordValidationError);
    expect(() => validateAddress("G123", "test")).toThrow(AccordValidationError);
  });

  it("validates array of addresses and rejects duplicates", () => {
    expect(() => validateAddresses([validAccount, validContract], "owners")).not.toThrow();
    expect(() => validateAddresses([validAccount, validAccount], "owners")).toThrow(AccordValidationError);
    expect(() => validateAddresses([], "empty")).toThrow(AccordValidationError);
  });

  it("validates positive bigint amounts", () => {
    expect(() => validatePositiveAmount(100n, "amount")).not.toThrow();
    expect(() => validatePositiveAmount(1n, "amount")).not.toThrow();
    expect(() => validatePositiveAmount(0n, "amount")).toThrow(AccordValidationError);
    expect(() => validatePositiveAmount(-50n, "amount")).toThrow(AccordValidationError);
    // @ts-expect-error testing invalid type
    expect(() => validatePositiveAmount(100, "amount")).toThrow(AccordValidationError);
  });

  it("validates description length constraints (1..=300)", () => {
    expect(() => validateDescription("Valid description")).not.toThrow();
    expect(() => validateDescription("")).toThrow(AccordValidationError);
    expect(() => validateDescription("   ")).toThrow(AccordValidationError);
    expect(() => validateDescription("a".repeat(300))).not.toThrow();
    expect(() => validateDescription("a".repeat(301))).toThrow(AccordValidationError);
  });

  it("validates deadline timestamp", () => {
    expect(() => validateDeadline(1800000000n)).not.toThrow();
    expect(() => validateDeadline(0n)).toThrow(AccordValidationError);
    expect(() => validateDeadline(-10n)).toThrow(AccordValidationError);
  });

  it("validates threshold bounds", () => {
    expect(() => validateThreshold(1, 3)).not.toThrow();
    expect(() => validateThreshold(2, 2)).not.toThrow();
    expect(() => validateThreshold(0, 3)).toThrow(AccordValidationError);
    expect(() => validateThreshold(4, 3)).toThrow(AccordValidationError);
  });

  it("validates owner weight bounds", () => {
    expect(() => validateWeight(1)).not.toThrow();
    expect(() => validateWeight(100_000)).not.toThrow();
    expect(() => validateWeight(0)).toThrow(AccordValidationError);
    expect(() => validateWeight(100_001)).toThrow(AccordValidationError);
  });
});
