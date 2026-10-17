import { vi, type MockInstance } from "vitest";
import {
  defaultReadFixtures,
  txReceiptFixture,
  type ContractReadFixtures,
  type ContractTxReceipt,
} from "./contractFixtures";

/**
 * A single shared harness that simulates Accord contract calls.
 *
 * Every hook and component test that touches `lib/contract.ts` or
 * `lib/submit.ts` routes through this module, so mocked responses stay aligned
 * with one another and with the real contract instead of drifting per test file.
 *
 * ## Usage
 *
 * ```ts
 * import { vi } from "vitest";
 * import { applyContractHarness, installContractCallHarness } from "../../test/harness";
 *
 * vi.mock("../../lib/contract", (importOriginal) => applyContractHarness(importOriginal));
 * vi.mock("../../lib/submit", (importOriginal) => applyContractHarness(importOriginal));
 *
 * const contract = installContractCallHarness();
 * ```
 *
 * `applyContractHarness` keeps every *pure* export real (only the I/O surface
 * is replaced), and `installContractCallHarness` gives the test a controller
 * for switching between success, failure and slow responses and for asserting
 * on what was called.
 */

export type HarnessMode = "success" | "failure" | "slow";

/** Exports of `lib/contract.ts` that resolve a contract read. */
const READ_EXPORTS = [
  "getOwners",
  "getOwnerWeights",
  "getOwnerWeight",
  "getApproverWeight",
  "getTotalWeight",
  "getThreshold",
  "getRequiredQuorumWeight",
  "getWeightCapPct",
  "getProposal",
  "getProposalsPaged",
  "getTotalProposals",
  "getProposalApprovalProgress",
  "hasApproved",
  "getApprovers",
  "getLatestLedger",
  "getContractEvents",
  "getContractXlmBalance",
  "getContractUsdcBalance",
  "getGuardian",
  "isFrozen",
  "getRoleVersion",
  "getRoles",
  "hasRole",
  "getRoleMembers",
  "getSpendingLimit",
  "getDelegations",
  "getActiveDelegations",
  "getRecurringPayments",
  "getRecurringPaymentsPaged",
  "getDueRecurring",
  "getTotalRecurringPayments",
  "getRecurringPayment",
  "getClaimableAmount",
  "getNextDisbursementTime",
  "getProposalEvents",
  "getOwnerWeightChangeEvents",
  "getHistoricalWeightChangeEvents",
] as const satisfies ReadonlyArray<keyof ContractReadFixtures>;

/** Exports of `lib/submit.ts` that send a transaction to the contract. */
const WRITE_EXPORTS = [
  "approveProposal",
  "executeProposal",
  "revokeProposal",
  "disburseRecurring",
  "disburseRecurringPayment",
  "createProposal",
  "createDelegation",
  "createSpendingLimitProposal",
  "freeze",
  "createSetGuardianProposal",
  "createUnfreezeProposal",
  "buildAndAssembleTx",
  "signAndSubmitMultiSig",
  "estimateCreateProposalFee",
  "createGrantRoleProposal",
  "createRevokeRoleProposal",
  "createRecurringPaymentProposal",
  "createCancelRecurringProposal",
  "createPauseRecurringProposal",
  "createResumeRecurringProposal",
  "createModifyRecurringProposal",
  "createAddOwnerProposal",
  "createRemoveOwnerProposal",
  "createChangeThresholdProposal",
  "createChangeOwnerWeightProposal",
] as const;

export type ContractReadName = (typeof READ_EXPORTS)[number];
export type ContractWriteName = (typeof WRITE_EXPORTS)[number];

interface HarnessState {
  mode: HarnessMode;
  latencyMs: number;
  failure: Error | null;
  fixtures: ContractReadFixtures;
  overrides: Map<string, unknown>;
  txOverride: ContractTxReceipt | Error | null;
}

const state: HarnessState = {
  mode: "success",
  latencyMs: 0,
  failure: null,
  fixtures: defaultReadFixtures(),
  overrides: new Map(),
  txOverride: null,
};

// Mock instances are created once and reused across every `vi.mock` factory
// call, so `vi.mocked(contract.getProposal)` in a test observes the same spy
// the factory installed.
const readSpies = new Map<string, MockInstance>();
const writeSpies = new Map<string, MockInstance>();

const DEFAULT_SLOW_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function settle(name: string): Promise<void> {
  if (state.mode === "slow" || state.latencyMs > 0) {
    await sleep(state.mode === "slow" && state.latencyMs === 0 ? DEFAULT_SLOW_MS : state.latencyMs);
  }
  // A failure always wins over latency so a slow failure still rejects.
  if (state.failure) throw state.failure;
  if (state.mode === "failure") throw new Error(`[contract-harness] ${name} failed`);
}

/**
 * Reads whose answer depends on their arguments resolve through these, so a
 * call like `getProposal(5)` returns proposal 5 rather than a fixed fixture.
 * Everything else falls back to the static default world.
 */
const READ_RESOLVERS: Partial<Record<ContractReadName, (args: unknown[], fixtures: ContractReadFixtures) => unknown>> = {
  getProposal: ([id], { getProposal }) => ({ ...getProposal, id: Number(id) }),
  getRecurringPayment: ([id], { getRecurringPayment }) =>
    getRecurringPayment ? { ...getRecurringPayment, id: Number(id) } : null,
  getOwnerWeight: ([address], { getOwnerWeights }) =>
    BigInt(getOwnerWeights.find((entry) => entry.address === address)?.weight ?? 0),
  getApproverWeight: ([address], { getOwnerWeights }) =>
    getOwnerWeights.find((entry) => entry.address === address)?.weight ?? 0,
  getRoleMembers: (_args, { getRoleMembers }) => getRoleMembers,
};

function resolveRead(name: ContractReadName, args: unknown[]): unknown {
  if (state.overrides.has(name)) return state.overrides.get(name);
  const resolver = READ_RESOLVERS[name];
  return resolver ? resolver(args, state.fixtures) : state.fixtures[name];
}

function readSpy(name: ContractReadName): MockInstance {
  let spy = readSpies.get(name);
  if (!spy) {
    spy = vi.fn(async (...args: unknown[]) => {
      await settle(name);
      return resolveRead(name, args);
    });
    readSpies.set(name, spy);
  }
  return spy;
}

function writeSpy(name: ContractWriteName): MockInstance {
  let spy = writeSpies.get(name);
  if (!spy) {
    spy = vi.fn(async () => {
      await settle(name);
      if (state.txOverride instanceof Error) throw state.txOverride;
      return state.txOverride ?? txReceiptFixture();
    });
    writeSpies.set(name, spy);
  }
  return spy;
}

const READ_SET = new Set<string>(READ_EXPORTS);
const WRITE_SET = new Set<string>(WRITE_EXPORTS);

/**
 * Builds the object a `vi.mock` factory should return for `lib/contract.ts` or
 * `lib/submit.ts`.
 *
 * Only exports that the target module actually declares are replaced, so
 * `contract.ts` never grows write helpers it does not really export. Pure
 * helpers pass through untouched from `importOriginal`.
 */
export async function applyContractHarness(
  importOriginal: (() => Promise<unknown>) | undefined,
): Promise<Record<string, unknown>> {
  const actual = importOriginal
    ? ((await importOriginal()) as Record<string, unknown>)
    : {};
  const surface: Record<string, MockInstance> = {};
  for (const [name, value] of Object.entries(actual)) {
    if (typeof value !== "function") continue;
    if (READ_SET.has(name)) surface[name] = readSpy(name as ContractReadName);
    else if (WRITE_SET.has(name)) surface[name] = writeSpy(name as ContractWriteName);
  }
  return { ...actual, ...surface };
}

export interface ContractCallHarness {
  /** Current simulation mode. */
  readonly mode: HarnessMode;
  /** Switch between success, failure and slow responses. */
  setMode(mode: HarnessMode): void;
  /** Reject the next call(s) with a specific error. */
  setFailure(error: Error | null): void;
  /** Override the latency applied to every call, in ms. */
  setLatency(ms: number): void;
  /** Override what a specific read resolves to (value or rejecting error). */
  set(name: ContractReadName, value: unknown): void;
  /** Make every write reject with `error`, or resolve normally when null. */
  setWriteFailure(error: Error | null): void;
  /** Reset every spy and restore the default world. */
  reset(): void;
  /** Every call recorded by a read, in order. */
  calls(name: ContractReadName): unknown[][];
  /** Every call recorded by a write, in order. */
  callsToWrite(name: ContractWriteName): unknown[][];
  /** Number of times a read was called. */
  callCount(name: ContractReadName): number;
  /** Number of times a write was called. */
  writeCallCount(name: ContractWriteName): number;
  /** The read mock, for advanced assertions like `toHaveBeenCalledOnce`. */
  read(name: ContractReadName): MockInstance;
  /** The write mock, for advanced assertions. */
  write(name: ContractWriteName): MockInstance;
}

/**
 * Installs (or re-installs) the harness and returns its controller.
 *
 * Call this in `beforeEach` so each test starts from the default world.
 */
export function installContractCallHarness(): ContractCallHarness {
  resetHarness();
  return {
    get mode() {
      return state.mode;
    },
    setMode(mode) {
      state.mode = mode;
    },
    setFailure(error) {
      state.failure = error;
    },
    setLatency(ms) {
      state.latencyMs = ms;
    },
    set(name, value) {
      state.overrides.set(name, value);
    },
    setWriteFailure(error) {
      state.txOverride = error;
    },
    reset: resetHarness,
    calls: (name) => readSpy(name).mock.calls,
    callsToWrite: (name) => writeSpy(name).mock.calls,
    callCount: (name) => readSpy(name).mock.calls.length,
    writeCallCount: (name) => writeSpy(name).mock.calls.length,
    read: readSpy,
    write: writeSpy,
  };
}

/** Restores the default world and clears every recorded call. */
export function resetHarness(): void {
  state.mode = "success";
  state.latencyMs = 0;
  state.failure = null;
  state.fixtures = defaultReadFixtures();
  state.overrides = new Map();
  state.txOverride = null;
  for (const spy of readSpies.values()) spy.mockClear();
  for (const spy of writeSpies.values()) spy.mockClear();
}

/** Names the harness simulates, useful for asserting nothing is missing. */
export const HARNESS_READS = READ_EXPORTS;
export const HARNESS_WRITES = WRITE_EXPORTS;
