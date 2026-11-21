const STORAGE_KEY = "accord.proposal-workspaces.v1";

export type ProposalWorkspace = {
  id: string;
  name: string;
  contractId: string;
};

function isContractId(value: string): boolean {
  return /^C[A-Z2-7]{55}$/.test(value);
}

export function loadProposalWorkspaces(): ProposalWorkspace[] {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === null) {
    const contractId = import.meta.env.VITE_CONTRACT_ADDRESS as string | undefined;
    if (!contractId) return [];
    if (!isContractId(contractId)) {
      throw new Error("VITE_CONTRACT_ADDRESS is not a valid Stellar contract address.");
    }
    return [{ id: contractId, name: "Default workspace", contractId }];
  }

  const parsed: unknown = JSON.parse(stored);
  if (!Array.isArray(parsed)) {
    throw new Error("Saved workspaces have an invalid format. Remove the saved workspace data to continue.");
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
      throw new Error("A saved workspace has an invalid contract address. Remove or correct it before continuing.");
    }

    return {
      id: item.contractId,
      name: item.name,
      contractId: item.contractId,
    };
  });
}

export function saveProposalWorkspaces(workspaces: ProposalWorkspace[]): void {
  const seen = new Set<string>();
  const clean = workspaces.map(({ name, contractId }) => {
    const trimmedName = name.trim();
    const trimmedContractId = contractId.trim();
    if (!trimmedName) throw new Error("Workspace name is required.");
    if (!isContractId(trimmedContractId)) {
      throw new Error("Enter a valid Stellar contract address.");
    }
    if (seen.has(trimmedContractId)) {
      throw new Error("That contract is already in your proposal inbox.");
    }
    seen.add(trimmedContractId);
    return {
      id: trimmedContractId,
      name: trimmedName,
      contractId: trimmedContractId,
    };
  });

  localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
}
