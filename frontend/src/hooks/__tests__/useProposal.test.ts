import { describe, test, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useProposal } from "../useProposal";
import { getProposal, getProposalApprovalProgress } from "../../lib/contract";

vi.mock("../../lib/contract", () => ({
  getProposal: vi.fn(),
  getProposalApprovalProgress: vi.fn(),
}));

const mockProgress = { approvalWeight: 10, quorumWeight: 50, totalWeight: 100 };

describe("useProposal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("loads proposal with weight data successfully", async () => {
    const mockProposal = { id: 1, description: "Test 1" };
    vi.mocked(getProposal).mockResolvedValueOnce(mockProposal as any);
    vi.mocked(getProposalApprovalProgress).mockResolvedValueOnce(mockProgress);

    const { result } = renderHook(() => useProposal(1));

    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.proposal).toMatchObject({
      ...mockProposal,
      ...mockProgress,
    });
    expect(result.current.error).toBeNull();
    expect(getProposal).toHaveBeenCalledWith(1);
    expect(getProposalApprovalProgress).toHaveBeenCalledWith(1);
  });

  test("contract error sets error and skips weight fetch", async () => {
    vi.mocked(getProposal).mockRejectedValueOnce(new Error("RPC failed"));

    const { result } = renderHook(() => useProposal(99));

    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe("RPC failed");
    expect(result.current.proposal).toBeNull();
    expect(getProposalApprovalProgress).not.toHaveBeenCalled();
  });

  test("weight fetch failure surfaces error but still returns proposal", async () => {
    const mockProposal = { id: 7, description: "Weight fail" };
    vi.mocked(getProposal).mockResolvedValueOnce(mockProposal as any);
    vi.mocked(getProposalApprovalProgress).mockRejectedValueOnce(
      new Error("RPC timeout"),
    );

    const { result } = renderHook(() => useProposal(7));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe("Weight data unavailable: RPC timeout");
    expect(result.current.proposal).toMatchObject({
      id: 7,
      description: "Weight fail",
      approvalWeight: 0,
      quorumWeight: 0,
      totalWeight: 0,
    });
  });

  test("changing IDs fetches new proposals and their weight data", async () => {
    const p2 = { id: 2, description: "Test 2" };
    const p3 = { id: 3, description: "Test 3" };
    const progress2 = { approvalWeight: 5, quorumWeight: 25, totalWeight: 50 };
    const progress3 = { approvalWeight: 15, quorumWeight: 30, totalWeight: 60 };

    vi.mocked(getProposal)
      .mockResolvedValueOnce(p2 as any)
      .mockResolvedValueOnce(p3 as any);
    vi.mocked(getProposalApprovalProgress)
      .mockResolvedValueOnce(progress2)
      .mockResolvedValueOnce(progress3);

    const { result, rerender } = renderHook(({ id }) => useProposal(id), {
      initialProps: { id: 2 },
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.proposal).toMatchObject({ ...p2, ...progress2 });

    rerender({ id: 3 });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.proposal).toMatchObject({ ...p3, ...progress3 });
    });
  });

  test("cache behaviour includes weight data", async () => {
    const mockProposal = { id: 5, description: "Test 5" };
    vi.mocked(getProposal).mockResolvedValueOnce(mockProposal as any);
    vi.mocked(getProposalApprovalProgress).mockResolvedValueOnce(mockProgress);

    const { result: result1 } = renderHook(() => useProposal(5));

    await waitFor(() => {
      expect(result1.current.loading).toBe(false);
    });
    expect(result1.current.proposal).toMatchObject({
      ...mockProposal,
      ...mockProgress,
    });

    // Second hook call should use cache — no additional fetches
    const { result: result2 } = renderHook(() => useProposal(5));

    await new Promise((r) => setTimeout(r, 10));

    expect(result2.current.loading).toBe(false);
    expect(result2.current.proposal).toMatchObject({
      ...mockProposal,
      ...mockProgress,
    });
    expect(getProposal).toHaveBeenCalledTimes(1);
    expect(getProposalApprovalProgress).toHaveBeenCalledTimes(1);
  });
});
