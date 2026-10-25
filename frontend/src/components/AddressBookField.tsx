import { useState } from "react";
import { BookmarkPlus } from "lucide-react";
import { useAddressBook } from "../hooks/useAddressBook";

type Props = {
  /** Current recipient address typed into the host form's own input. */
  address: string;
  /** Whether `address` is a valid Stellar address, so saving is offered. */
  isValidAddress: boolean;
  /** Called when the user picks a saved recipient from the dropdown. */
  onSelectAddress: (address: string) => void;
  idPrefix: string;
};

/**
 * A saved-recipients dropdown plus a "save to address book" control, meant
 * to sit above a recipient address `<input>` in a proposal/schedule form.
 */
export function AddressBookField({ address, isValidAddress, onSelectAddress, idPrefix }: Props) {
  const { entries, save } = useAddressBook();
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");

  const alreadySaved = entries.some((e) => e.address === address.trim());

  function handleSelect(value: string) {
    if (!value) return;
    onSelectAddress(value);
  }

  function handleSaveClick() {
    setName("");
    setSaving(true);
  }

  function handleConfirmSave() {
    if (!name.trim()) return;
    save(name.trim(), address.trim());
    setSaving(false);
  }

  function handleCancelSave() {
    setSaving(false);
  }

  return (
    <div className="space-y-1.5">
      {entries.length > 0 && (
        <select
          id={`${idPrefix}-address-book`}
          aria-label="Choose a saved recipient"
          value=""
          onChange={(e) => handleSelect(e.target.value)}
          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-zinc-300 focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-500"
        >
          <option value="">Choose a saved recipient…</option>
          {entries.map((entry) => (
            <option key={entry.id} value={entry.address}>
              {entry.name} ({entry.address.slice(0, 6)}…{entry.address.slice(-4)})
            </option>
          ))}
        </select>
      )}

      {isValidAddress && !alreadySaved && !saving && (
        <button
          type="button"
          onClick={handleSaveClick}
          className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-emerald-400 transition-colors"
        >
          <BookmarkPlus size={13} />
          Save to address book
        </button>
      )}

      {saving && (
        <div className="flex items-center gap-2">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleConfirmSave();
              if (e.key === "Escape") handleCancelSave();
            }}
            placeholder="Recipient name"
            aria-label="Recipient name"
            maxLength={40}
            className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-zinc-600 focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-500"
          />
          <button
            type="button"
            onClick={handleConfirmSave}
            disabled={!name.trim()}
            className="text-xs font-medium text-emerald-400 hover:text-emerald-300 disabled:opacity-50"
          >
            Save
          </button>
          <button
            type="button"
            onClick={handleCancelSave}
            className="text-xs text-zinc-600 dark:text-zinc-400 hover:text-zinc-300"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
