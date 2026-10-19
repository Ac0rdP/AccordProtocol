import { describe, expect, test, vi, beforeEach } from "vitest";
import {
  applyContractHarness,
  installContractCallHarness,
  HARNESS_READS,
  HARNESS_WRITES,
} from "./harness";
import { HARNESS_ACCOUNT, proposalFixture, txReceiptFixture } from "./contractFixtures";

// The harness replaces only the I/O surface; pure helpers keep real behaviour.
vi.mock("../lib/contract", (importOriginal) => applyContractHarness(importOriginal));
vi.mock("../lib/submit", (importOriginal) => applyContractHarness(importOriginal));

import * as contract from "../lib/contract";
import * as submit from "../lib/submit";

/** Pure helpers that must never be replaced by the harness. */
const PURE_CONTRACT_EXPORTS = [
  "mapProposal",
  "canonicalEventKey",
  "dedupeContractEvents",
  "computeMonthlyOutflow",
  "reconstructTotalWeightHistory",
];
const PURE_SUBMIT_EXPORTS = ["mapProposal", "mapSubmissionError", "withSubmissionRetry"];

const harness = installContractCallHarness();

beforeEach(() => harness.reset());

function functionExports(module: Record<string, unknown>): string[] {
  return Object.entries(module)
    .filter(([, value]) => typeof value === "function")
    .map(([name]) => name)
    .sort();
}

describe("contract harness surface", () => {
  test("mocks every read and write the contract modules expose", () => {
    // Guards against drift: a new contract export must be added to the harness
    // (as a simulated read/write) or explicitly listed as a pure helper.
    const simulated = new Set<string>([...HARNESS_READS, ...HARNESS_WRITES]);
    const unclassified = functionExports(contract as unknown as Record<string, unknown>).filter(
      (name) => !simulated.has(name) && !PURE_CONTRACT_EXPORTS.includes(name),
    );
    expect(unclassified).toEqual([]);

    const unclassifiedWrites = functionExports(submit as unknown as Record<string, unknown>).filter(
      (name) => !simulated.has(name) && !PURE_SUBMIT_EXPORTS.includes(name),
    );
    expect(unclassifiedWrites).toEqual([]);
  });

  test("only replaces exports the target module really declares", () => {
    const contractKeys = Object.keys(contract as unknown as Record<string, unknown>);
    const submitKeys = Object.keys(submit as unknown as Record<string, unknown>);
    // contract.ts must not grow write helpers it does not export...
    expect(contractKeys).not.toContain("signAndSubmitMultiSig");
    expect(contractKeys).not.toContain("createDelegation");
    // ...while submit.ts keeps them, since that is where they live.
    expect(submitKeys).toContain("signAndSubmitMultiSig");
    expect(submitKeys).toContain("createDelegation");
    expect(submitKeys).toContain("approveProposal");
  });

  test("keeps pure helpers real so their own tests keep working", () => {
    expect(contract.canonicalEventKey).toBeTypeOf("function");
    expect(contract.mapProposal).toBeTypeOf("function");
    expect(submit.mapProposal).toBeTypeOf("function");
    // A real call, not a spy: the passthrough from importOriginal is intact.
    const mapped = contract.mapProposal(
      {
        id: "3",
        deadline: "1790851200",
        kind: { Transfer: [HARNESS_ACCOUNT.secondOwner, "50000000", HARNESS_ACCOUNT.token] },
        description: "Payroll run",
        approvals: "1",
        status: "Pending",
        proposer: HARNESS_ACCOUNT.owner,
      },
      2,
    );
    expect(mapped.id).toBe(3);
    expect(mapped.kind).toBe("transfer");
    expect(mapped.status).toBe("pending");
  });
});

describe("contract harness reads", () => {
  test("serves a consistent default world", async () => {
    expect(await contract.getThreshold()).toBe(2);
    expect(await contract.getOwners()).toEqual([
      HARNESS_ACCOUNT.owner,
      HARNESS_ACCOUNT.secondOwner,
    ]);
    const weights = await contract.getOwnerWeights();
    expect(weights.map(({ weight }) => weight)).toEqual([6, 4]);
    expect(await contract.getTotalWeight()).toBe(10);
    expect(await contract.getLatestLedger()).toBe(1050);
  });

  test("records arguments so tests can assert what a hook asked for", async () => {
    await contract.getProposal(7);
    await contract.getProposal(9);
    expect(harness.calls("getProposal")).toEqual([[7], [9]]);
    expect(harness.callCount("getProposal")).toBe(2);
  });

  test("a single override replaces one read without touching the rest", async () => {
    harness.set("getProposal", proposalFixture({ id: 42, description: "Overridden" }));
    const proposal = await contract.getProposal(42);
    expect(proposal.description).toBe("Overridden");
    expect(await contract.getThreshold()).toBe(2);
  });

  test("an override may be a promise, so async values can be simulated", async () => {
    harness.set("getProposal", Promise.resolve(proposalFixture({ id: 42, description: "Async" })));
    const proposal = await contract.getProposal(42);
    expect(proposal.description).toBe("Async");
  });
});

describe("contract harness modes", () => {
  test("failure mode rejects every read with a message naming the call", async () => {
    harness.setMode("failure");
    await expect(contract.getThreshold()).rejects.toThrow("[contract-harness] getThreshold failed");
    await expect(contract.getOwnerWeights()).rejects.toThrow("getOwnerWeights failed");
  });

  test("failure mode also rejects writes", async () => {
    harness.setMode("failure");
    await expect(submit.approveProposal(HARNESS_ACCOUNT.owner, 1)).rejects.toThrow(
      "approveProposal failed",
    );
  });

  test("a specific error can be injected and then cleared", async () => {
    const offline = new Error("RPC offline");
    harness.setFailure(offline);
    await expect(contract.getProposal(1)).rejects.toBe(offline);
    harness.setFailure(null);
    await expect(contract.getProposal(1)).resolves.toBeTypeOf("object");
  });

  test("slow mode delays responses so loading states can be asserted", async () => {
    harness.setMode("slow");
    const started = Date.now();
    const pending = contract.getThreshold();
    // The call must still be pending immediately after it is made.
    let resolved = false;
    void pending.then(() => { resolved = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resolved).toBe(false);
    await expect(pending).resolves.toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  test("latency can be set explicitly, including zero", async () => {
    harness.setLatency(50);
    const started = Date.now();
    await contract.getThreshold();
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);

    harness.setLatency(0);
    harness.setMode("success");
    const quick = Date.now();
    await contract.getThreshold();
    expect(Date.now() - quick).toBeLessThan(30);
  });

  test("slow mode still reports the configured error", async () => {
    harness.setMode("slow");
    harness.setFailure(new Error("timed out"));
    await expect(contract.getLatestLedger()).rejects.toThrow("timed out");
  });
});

describe("contract harness writes", () => {
  test("writes resolve to a receipt and record their arguments", async () => {
    const result = await submit.approveProposal(HARNESS_ACCOUNT.owner, 12);
    expect(result).toEqual(txReceiptFixture());
    expect(harness.callsToWrite("approveProposal")).toEqual([[HARNESS_ACCOUNT.owner, 12]]);
    expect(harness.writeCallCount("approveProposal")).toBe(1);
    // Reads stay untouched by write assertions.
    expect(harness.callCount("getProposal")).toBe(0);
  });

  test("a write can be made to fail on its own", async () => {
    harness.setWriteFailure(new Error("insufficient balance"));
    await expect(submit.createProposal(
      HARNESS_ACCOUNT.owner,
      HARNESS_ACCOUNT.secondOwner,
      HARNESS_ACCOUNT.token,
      1_000n,
      "Payroll",
      1_790_851_200n,
    )).rejects.toThrow("insufficient balance");
    await expect(submit.approveProposal(HARNESS_ACCOUNT.owner, 1)).rejects.toThrow("insufficient balance");
  });

  test("clearing the write failure restores successful submissions", async () => {
    harness.setWriteFailure(new Error("boom"));
    await expect(submit.freeze(HARNESS_ACCOUNT.owner)).rejects.toThrow("boom");
    harness.setWriteFailure(null);
    await expect(submit.freeze(HARNESS_ACCOUNT.owner)).resolves.toEqual(txReceiptFixture());
  });
});

describe("contract harness reset", () => {
  test("reset restores fixtures and clears recorded calls", async () => {
    harness.set("getThreshold", 99);
    harness.setMode("failure");
    await contract.getThreshold().catch(() => undefined);
    await contract.getProposal(1).catch(() => undefined);
    expect(harness.callCount("getThreshold")).toBe(1);

    harness.reset();

    // Recorded calls are cleared, so the next assertion is not polluted.
    expect(harness.mode).toBe("success");
    expect(harness.callCount("getThreshold")).toBe(0);
    expect(harness.callCount("getProposal")).toBe(0);
    expect(await contract.getThreshold()).toBe(2);
  });
});
