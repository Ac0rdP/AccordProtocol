import { beforeEach, describe, expect, test } from "vitest";
import {
  ACTIVE_WORKSPACE_STORAGE_KEY,
  WORKSPACES_STORAGE_KEY,
  getActiveWorkspace,
  getWorkspaceStorageKey,
  loadWorkspaces,
  saveWorkspaces,
  setActiveWorkspace,
  type Workspace,
} from "./workspaces";

const first: Workspace = {
  id: `C${"A".repeat(55)}`,
  name: "Operations",
  contractId: `C${"A".repeat(55)}`,
  network: "Testnet",
};

const second: Workspace = {
  id: `C${"B".repeat(55)}`,
  name: "Treasury",
  contractId: `C${"B".repeat(55)}`,
  network: "Public",
};

describe("workspaces", () => {
  beforeEach(() => localStorage.clear());

  test("persists and switches between workspaces", () => {
    saveWorkspaces([first, second]);

    expect(loadWorkspaces()).toEqual([first, second]);
    setActiveWorkspace(second);

    expect(localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY)).toBe(second.contractId);
    expect(getActiveWorkspace(loadWorkspaces())).toEqual(second);
  });

  test("isolates workspace preferences and caches", () => {
    expect(getWorkspaceStorageKey(first, "saved-view")).not.toBe(
      getWorkspaceStorageKey(second, "saved-view"),
    );
    expect(getWorkspaceStorageKey(first, "proposal-cache")).not.toBe(
      getWorkspaceStorageKey(second, "proposal-cache"),
    );
  });

  test("rejects invalid or duplicate workspace contracts", () => {
    expect(() =>
      saveWorkspaces([{ ...first, contractId: "invalid" }]),
    ).toThrow("valid Stellar contract address");
    expect(() => saveWorkspaces([first, { ...second, contractId: first.contractId }])).toThrow(
      "already configured",
    );
  });

  test("reports corrupted workspace data", () => {
    localStorage.setItem(WORKSPACES_STORAGE_KEY, "{");
    expect(() => loadWorkspaces()).toThrow("Saved workspaces");
  });
});
