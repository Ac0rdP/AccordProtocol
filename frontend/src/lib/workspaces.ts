import { PORTFOLIO_STORAGE_KEY } from "./portfolio";

export const WORKSPACES_STORAGE_KEY = "accord-workspaces-v1";
export const ACTIVE_WORKSPACE_STORAGE_KEY = "accord-active-workspace-v1";

export type Workspace = {
  id: string;
  name: string;
  contractId: string;
  network: string;
};

function isContractId(value: string): boolean {
  return /^C[A-Z2-7]{55}$/.test(value);
}

function defaultNetwork(): string {
  return (import.meta.env.VITE_NETWORK_PASSPHRASE as string | undefined) ?? "stellar";
}

function defaultContractId(): string | undefined {
  const contractId = import.meta.env.VITE_CONTRACT_ADDRESS as string | undefined;
  return contractId && isContractId(contractId) ? contractId : undefined;
}

export function loadWorkspaces(): Workspace[] {
  if (typeof window === "undefined") {
    const contractId = defaultContractId();
    return contractId
      ? [{ id: contractId, name: "Default workspace", contractId, network: defaultNetwork() }]
      : [];
  }

  const raw = window.localStorage.getItem(WORKSPACES_STORAGE_KEY);
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Saved workspaces are invalid. Remove their local storage entry to reset them.");
    }
    if (!Array.isArray(parsed)) {
      throw new Error("Saved workspaces are invalid.");
    }
    return parsed.map((item: unknown) => {
      if (
        !item ||
        typeof item !== "object" ||
        !("name" in item) ||
        !("contractId" in item) ||
        typeof item.name !== "string" ||
        typeof item.contractId !== "string" ||
        !isContractId(item.contractId)
      ) {
        throw new Error("A saved workspace has an invalid contract address.");
      }
      return {
        id: item.contractId,
        name: item.name.trim() || "Workspace",
        contractId: item.contractId,
        network:
          "network" in item && typeof item.network === "string" && item.network.trim()
            ? item.network
            : defaultNetwork(),
      };
    });
  }

  const legacyRaw = window.localStorage.getItem(PORTFOLIO_STORAGE_KEY);
  let contractIds: string[] = [];
  if (legacyRaw) {
    try {
      const parsed = JSON.parse(legacyRaw);
      if (Array.isArray(parsed)) {
        contractIds = parsed.filter(
          (contractId): contractId is string =>
            typeof contractId === "string" && isContractId(contractId),
        );
      }
    } catch {
      contractIds = [];
    }
  } else {
    const contractId = defaultContractId();
    if (contractId) contractIds = [contractId];
  }
  return Array.from(new Set(contractIds)).map((contractId) => ({
    id: contractId,
    name: "Workspace",
    contractId,
    network: defaultNetwork(),
  }));
}

export function saveWorkspaces(workspaces: Workspace[]): void {
  const seen = new Set<string>();
  const clean = workspaces.map((workspace) => {
    const name = workspace.name.trim();
    const contractId = workspace.contractId.trim();
    if (!name) throw new Error("Workspace name is required.");
    if (!isContractId(contractId)) throw new Error("Enter a valid Stellar contract address.");
    if (seen.has(contractId)) throw new Error("That contract is already configured.");
    seen.add(contractId);
    return {
      id: contractId,
      name,
      contractId,
      network: workspace.network.trim() || defaultNetwork(),
    };
  });
  if (typeof window === "undefined") return;
  window.localStorage.setItem(WORKSPACES_STORAGE_KEY, JSON.stringify(clean));
  window.localStorage.setItem(
    PORTFOLIO_STORAGE_KEY,
    JSON.stringify(clean.map((workspace) => workspace.contractId)),
  );
}

export function getActiveWorkspace(workspaces: Workspace[] = loadWorkspaces()): Workspace | null {
  if (workspaces.length === 0) return null;
  if (typeof window === "undefined") return workspaces[0];
  const activeId =
    window.localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY) ??
    window.localStorage.getItem("accord-active-contract");
  return workspaces.find((workspace) => workspace.contractId === activeId) ?? workspaces[0];
}

export function setActiveWorkspace(workspace: Workspace): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, workspace.contractId);
  window.localStorage.setItem("accord-active-contract", workspace.contractId);
}

export function getWorkspaceStorageKey(workspace: Workspace, preference: string): string {
  return `accord.workspace.${workspace.contractId}.${preference}`;
}
