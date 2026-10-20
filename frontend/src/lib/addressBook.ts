export type AddressBookEntry = {
  id: string;
  name: string;
  address: string;
};

const ADDRESS_BOOK_KEY = "accord_address_book";

export function getAddressBook(): AddressBookEntry[] {
  try {
    const raw = localStorage.getItem(ADDRESS_BOOK_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function persist(entries: AddressBookEntry[]): void {
  try {
    localStorage.setItem(ADDRESS_BOOK_KEY, JSON.stringify(entries));
  } catch {
    // localStorage might be unavailable or throw in restricted environments
  }
}

/** Saves a new recipient, or renames the existing entry for that address. */
export function saveAddressBookEntry(name: string, address: string): AddressBookEntry {
  const entries = getAddressBook();
  const existing = entries.find((e) => e.address === address);
  if (existing) {
    existing.name = name;
    persist(entries);
    return existing;
  }
  const entry: AddressBookEntry = {
    id: `${address}-${Date.now()}`,
    name,
    address,
  };
  entries.push(entry);
  persist(entries);
  return entry;
}

export function updateAddressBookEntry(
  id: string,
  patch: Partial<Pick<AddressBookEntry, "name" | "address">>,
): void {
  const entries = getAddressBook();
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) return;
  entries[idx] = { ...entries[idx], ...patch };
  persist(entries);
}

export function removeAddressBookEntry(id: string): void {
  persist(getAddressBook().filter((e) => e.id !== id));
}
