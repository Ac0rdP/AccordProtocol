export type OwnerLabelMap = Record<string, string>;

const OWNER_LABELS_KEY = "accord_owner_labels";

export function getOwnerLabels(): OwnerLabelMap {
  try {
    const raw = localStorage.getItem(OWNER_LABELS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Returns the user-saved label for an owner address, or null when none was set. */
export function getOwnerLabel(address: string): string | null {
  const label = getOwnerLabels()[address];
  return label && label.trim() ? label : null;
}

/** Saves (or clears, when `label` is blank) the custom label for an owner address. */
export function setOwnerLabel(address: string, label: string): void {
  try {
    const labels = getOwnerLabels();
    const trimmed = label.trim();
    if (trimmed) {
      labels[address] = trimmed;
    } else {
      delete labels[address];
    }
    localStorage.setItem(OWNER_LABELS_KEY, JSON.stringify(labels));
  } catch {
    // localStorage might be unavailable or throw in restricted environments
  }
}
