const STORAGE_KEY = "accord-active-contract";
const DEFAULT_CONTRACT_ID = import.meta.env.VITE_CONTRACT_ADDRESS as string;

function readStoredContractId(): string {
  if (typeof window === "undefined") return DEFAULT_CONTRACT_ID;
  try {
    return window.localStorage.getItem(STORAGE_KEY) || DEFAULT_CONTRACT_ID;
  } catch (error) {
    console.error("Could not read the active contract from local storage.", error);
    return DEFAULT_CONTRACT_ID;
  }
}

let activeContractId = readStoredContractId();

export function getActiveContractId(): string {
  return activeContractId;
}

export function setActiveContractId(contractId: string): void {
  if (!contractId.trim()) {
    throw new Error("Contract ID is required.");
  }
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, contractId.trim());
  }
  activeContractId = contractId.trim();
}
