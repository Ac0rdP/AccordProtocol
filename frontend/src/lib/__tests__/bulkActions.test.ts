import { describe, expect, it, vi } from "vitest";
import {
  eligibleProposals,
  isBulkEligible,
  retryableIds,
  runBulkAction,
  summarizeResults,
  type BulkItemResult,
} from "../bulkActions";
import { baseProposal } from "../../stories/fixtures";

describe("bulk action eligibility", () => {
  it("approve targets pending proposals the wallet has not approved", () => {
    expect(isBulkEligible(baseProposal({ status: "pending" }), "approve")).toBe(true);
    expect(
      isBulkEligible(baseProposal({ status: "pending", userHasApproved: true }), "approve"),
    ).toBe(false);
    expect(isBulkEligible(baseProposal({ status: "ready" }), "approve")).toBe(false);
  });

  it("execute targets ready proposals only", () => {
    expect(isBulkEligible(baseProposal({ status: "ready" }), "execute")).toBe(true);
    expect(isBulkEligible(baseProposal({ status: "pending" }), "execute")).toBe(false);
    expect(isBulkEligible(baseProposal({ status: "executed" }), "execute")).toBe(false);
  });

  it("returns eligible proposals sorted by id", () => {
    const list = [
      baseProposal({ id: 9, status: "ready" }),
      baseProposal({ id: 2, status: "ready" }),
      baseProposal({ id: 5, status: "pending" }),
    ];
    expect(eligibleProposals(list, "execute").map((p) => p.id)).toEqual([2, 9]);
  });
});

describe("runBulkAction", () => {
  it("runs sequentially and records a result per item, continuing past failures", async () => {
    const order: number[] = [];
    let active = 0;
    const perform = vi.fn(async (id: number) => {
      active += 1;
      expect(active).toBe(1); // never two in flight
      order.push(id);
      await Promise.resolve();
      active -= 1;
      if (id === 2) throw new Error("Insufficient approval weight");
    });
    const updates: BulkItemResult[][] = [];

    const results = await runBulkAction([1, 2, 3], perform, (r) => updates.push(r));

    expect(order).toEqual([1, 2, 3]);
    expect(results).toEqual([
      { id: 1, status: "succeeded" },
      { id: 2, status: "failed", error: "Insufficient approval weight" },
      { id: 3, status: "succeeded" },
    ]);
    expect(updates[0].every((r) => r.status === "queued")).toBe(true);
    expect(updates.some((u) => u[1].status === "running")).toBe(true);
  });

  it("uses a generic message when the error has none", async () => {
    const results = await runBulkAction(
      [1],
      () => Promise.reject({}),
      () => {},
    );
    expect(results[0]).toEqual({ id: 1, status: "failed", error: "Transaction failed" });
  });

  it("skips remaining items after abort", async () => {
    const controller = new AbortController();
    const perform = vi.fn(async (id: number) => {
      if (id === 1) controller.abort();
    });
    const results = await runBulkAction([1, 2, 3], perform, () => {}, controller.signal);
    expect(perform).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.status)).toEqual(["succeeded", "skipped", "skipped"]);
  });
});

describe("result helpers", () => {
  const results: BulkItemResult[] = [
    { id: 1, status: "succeeded" },
    { id: 2, status: "failed", error: "x" },
    { id: 3, status: "skipped" },
  ];

  it("summarizes counts", () => {
    expect(summarizeResults(results)).toEqual({ total: 3, succeeded: 1, failed: 1, skipped: 1 });
  });

  it("lists failed and skipped ids for retry", () => {
    expect(retryableIds(results)).toEqual([2, 3]);
  });
});
