import { vi } from "vitest";
import { applyContractHarness, installContractCallHarness } from "../../test/harness";
import { proposalFixture } from "../../test/contractFixtures";

// One shared harness replaces ad-hoc per-file mocks, so these tests exercise
// the same response shapes the rest of the suite does.
vi.mock("../../lib/contract", (importOriginal) => applyContractHarness(importOriginal));

import { renderHook, waitFor } from "@testing-library/react";
import { useProposal } from "../useProposal";

const contract = installContractCallHarness();

// useProposal caches per id for the lifetime of the module, so every test uses
// its own ids to stay isolated.
beforeEach(() => contract.reset());

describe("useProposal", () => {
  test("loads a proposal and its approval progress from the shared fixtures", async () => {
    const { result } = renderHook(() => useProposal(1));

    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const fixture = proposalFixture();
    expect(result.current.proposal).toMatchObject({
      id: 1,
      description: fixture.description,
      approvalWeight: fixture.approvalWeight,
      quorumWeight: fixture.quorumWeight,
      totalWeight: fixture.totalWeight,
    });
    expect(result.current.error).toBeNull();
    expect(contract.calls("getProposal")).toEqual([[1]]);
    expect(contract.callCount("getProposalApprovalProgress")).toBe(1);
  });

  test("contract error sets error and skips the weight fetch", async () => {
    contract.read("getProposal").mockRejectedValueOnce(new Error("RPC failed"));

    const { result } = renderHook(() => useProposal(99));

    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe("RPC failed");
    expect(result.current.proposal).toBeNull();
    expect(contract.callCount("getProposalApprovalProgress")).toBe(0);
  });

  test("weight fetch failure surfaces an error but still returns the proposal", async () => {
    contract.read("getProposalApprovalProgress").mockRejectedValueOnce(new Error("RPC timeout"));

    const { result } = renderHook(() => useProposal(7));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe("Weight data unavailable: RPC timeout");
    expect(result.current.proposal).toMatchObject({
      id: 7,
      approvalWeight: 0,
      quorumWeight: 0,
      totalWeight: 0,
    });
  });

  test("changing ids fetches the new proposal", async () => {
    contract
      .read("getProposal")
      .mockResolvedValueOnce(proposalFixture({ id: 2, description: "Second" }))
      .mockResolvedValueOnce(proposalFixture({ id: 3, description: "Third" }));

    const { result, rerender } = renderHook(({ id }) => useProposal(id), {
      initialProps: { id: 2 },
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.proposal?.description).toBe("Second");

    rerender({ id: 3 });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.proposal?.description).toBe("Third");
    });
  });

  test("a second mount for the same id is served from the cache", async () => {
    const { result: first } = renderHook(() => useProposal(5));

    await waitFor(() => {
      expect(first.current.loading).toBe(false);
    });

    const { result: second } = renderHook(() => useProposal(5));

    await waitFor(() => {
      expect(second.current.loading).toBe(false);
    });

    // Cached, so the contract is never asked again.
    expect(contract.calls("getProposal")).toEqual([[5]]);
    expect(second.current.proposal).toMatchObject({ id: 5 });
  });

  test("slow responses keep the hook in its loading state", async () => {
    contract.setMode("slow");

    const { result } = renderHook(() => useProposal(11));

    // Still pending while the harness delays the call.
    expect(result.current.loading).toBe(true);
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.proposal).not.toBeNull();
  });

  test("a failing contract in failure mode rejects consistently", async () => {
    contract.setMode("failure");

    const { result } = renderHook(() => useProposal(13));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.error).toContain("getProposal failed");
    expect(result.current.proposal).toBeNull();
  });
});
