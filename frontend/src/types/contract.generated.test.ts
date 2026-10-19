import { describe, expect, expectTypeOf, test } from "vitest";
import { ContractError } from "./contract.generated";
import type {
  ContractProposalCategory,
  ContractProposalStatus,
  ContractRecurringStatus,
  ContractRole,
} from "./contract.generated";
import type {
  ProposalCategory,
  ProposalStatus,
  RecurringScheduleStatus,
  RecurringStatus,
  Role,
} from "./accord";

/**
 * These assertions keep `accord.ts` and the generated contract types in lock
 * step. If the contract gains or renames a variant, regeneration changes
 * `contract.generated.ts`, and any hand-written duplicate that no longer
 * matches fails here instead of at runtime.
 */
describe("generated contract types", () => {
  test("app ProposalStatus mirrors the contract status enum", () => {
    expectTypeOf<ProposalStatus>().toEqualTypeOf<
      Lowercase<ContractProposalStatus>
    >();
  });

  test("app roles are a superset of the contract capability roles", () => {
    expectTypeOf<ContractRole>().toMatchTypeOf<Role>();
  });

  test("app ProposalCategory is the contract category enum", () => {
    expectTypeOf<ProposalCategory>().toEqualTypeOf<ContractProposalCategory>();
  });

  test("recurring schedule status reuses the recurring status enum", () => {
    expectTypeOf<RecurringScheduleStatus>().toEqualTypeOf<RecurringStatus>();
    expectTypeOf<RecurringStatus>().toEqualTypeOf<
      Lowercase<ContractRecurringStatus>
    >();
  });

  test("ContractError discriminants are unique and stable", () => {
    const codes = Object.values(ContractError).filter(
      (value): value is number => typeof value === "number",
    );

    expect(codes.length).toBeGreaterThan(0);
    expect(new Set(codes).size).toBe(codes.length);

    // Spot-check a few values so a parser regression that silently renumbers
    // the enum is caught immediately.
    expect(ContractError.AlreadyInitialized).toBe(1);
    expect(ContractError.AlreadyMigrated).toBe(45);
    expect(ContractError.DeprecatedEntrypoint).toBe(56);
  });
});
