import { describe, expect, it } from "vitest";
import {
  AccordContractError,
  AccordError,
  AccordValidationError,
  ContractError,
  ERROR_MESSAGES,
  parseContractError,
} from "../errors.js";

describe("SDK Typed Error Handling", () => {
  it("maps numeric contract error codes to named enum variants", () => {
    const err = new AccordContractError(ContractError.Unauthorized);
    expect(err.errorCode).toBe(ContractError.Unauthorized);
    expect(err.codeName).toBe("Unauthorized");
    expect(err.message).toContain("Unauthorized (#3)");
    expect(err.message).toContain(ERROR_MESSAGES[ContractError.Unauthorized]);
  });

  it("handles newly added RecoveryActive error (code 57)", () => {
    const err = new AccordContractError(ContractError.RecoveryActive);
    expect(err.errorCode).toBe(57);
    expect(err.codeName).toBe("RecoveryActive");
    expect(err.message).toContain("RecoveryActive (#57)");
  });

  it("parses Soroban host Error(Contract, #XX) string into AccordContractError", () => {
    const rawError = "HostError: Error(Contract, #26)";
    const parsed = parseContractError(rawError);
    expect(parsed).toBeInstanceOf(AccordContractError);
    const contractErr = parsed as AccordContractError;
    expect(contractErr.errorCode).toBe(ContractError.ContractFrozen);
    expect(contractErr.codeName).toBe("ContractFrozen");
  });

  it("parses Error(Contract, 57) format", () => {
    const rawError = "Transaction failed with Error(Contract, 57)";
    const parsed = parseContractError(rawError);
    expect(parsed).toBeInstanceOf(AccordContractError);
    const contractErr = parsed as AccordContractError;
    expect(contractErr.errorCode).toBe(ContractError.RecoveryActive);
  });

  it("falls back to AccordRpcError for unrecognised host errors", () => {
    const rawError = "Simulation failed: RPC endpoint 503 Service Unavailable";
    const parsed = parseContractError(rawError);
    expect(parsed).not.toBeInstanceOf(AccordContractError);
    expect(parsed.name).toBe("AccordRpcError");
  });
});
