const PORTFOLIO_STORAGE_KEY = "accord-portfolio-contracts";

export function loadPortfolioContractIds(): string[] {
  const raw = window.localStorage.getItem(PORTFOLIO_STORAGE_KEY);
  if (raw === null) {
    const defaultContractId = import.meta.env.VITE_CONTRACT_ADDRESS as string;
    return defaultContractId ? [defaultContractId] : [];
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Saved portfolio list is invalid. Remove its local storage entry to reset it.");
  }

  if (
    !Array.isArray(value) ||
    !value.every((contractId) => typeof contractId === "string")
  ) {
    throw new Error("Saved portfolio list is invalid. Remove its local storage entry to reset it.");
  }
  return Array.from(new Set(value.map((contractId: string) => contractId.trim()).filter(Boolean)));
}

export function savePortfolioContractIds(contractIds: string[]): void {
  window.localStorage.setItem(
    PORTFOLIO_STORAGE_KEY,
    JSON.stringify(contractIds),
  );
}

export { PORTFOLIO_STORAGE_KEY };
