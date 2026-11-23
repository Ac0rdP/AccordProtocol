import { beforeEach, describe, expect, test } from "vitest";
import {
  loadProposalWorkspaces,
  saveProposalWorkspaces,
} from "./proposalWorkspaces";

const first = {
  id: `C${"A".repeat(55)}`,
  name: "Operations",
  contractId: `C${"A".repeat(55)}`,
};

describe("proposal workspaces", () => {
  beforeEach(() => localStorage.clear());

  test("persists and restores workspace names and contract IDs", () => {
    saveProposalWorkspaces([first]);
    expect(loadProposalWorkspaces()).toEqual([first]);
  });

  test("rejects malformed or duplicate contract IDs", () => {
    expect(() => saveProposalWorkspaces([{ ...first, contractId: "invalid" }])).toThrow(
      "valid Stellar contract address",
    );
    expect(() => saveProposalWorkspaces([first, { ...first, name: "Duplicate" }])).toThrow(
      "already in your proposal inbox",
    );
  });

  test("reports corrupted saved data instead of silently dropping it", () => {
    localStorage.setItem("accord.proposal-workspaces.v1", "{");
    expect(() => loadProposalWorkspaces()).toThrow();
  });
});
