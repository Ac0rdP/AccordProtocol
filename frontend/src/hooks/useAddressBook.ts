import { useCallback, useState } from "react";
import {
  getAddressBook,
  saveAddressBookEntry,
  updateAddressBookEntry,
  removeAddressBookEntry,
  type AddressBookEntry,
} from "../lib/addressBook";

export function useAddressBook() {
  const [entries, setEntries] = useState<AddressBookEntry[]>(() => getAddressBook());

  const save = useCallback((name: string, address: string) => {
    saveAddressBookEntry(name, address);
    setEntries(getAddressBook());
  }, []);

  const update = useCallback(
    (id: string, patch: Partial<Pick<AddressBookEntry, "name" | "address">>) => {
      updateAddressBookEntry(id, patch);
      setEntries(getAddressBook());
    },
    [],
  );

  const remove = useCallback((id: string) => {
    removeAddressBookEntry(id);
    setEntries(getAddressBook());
  }, []);

  return { entries, save, update, remove };
}
