import { useState } from "react";
import { Pencil, Check, X } from "lucide-react";
import { setOwnerLabel } from "../lib/ownerLabels";

type Props = {
  address: string;
  label: string;
  onSaved?: (label: string) => void;
  className?: string;
};

/** An owner label that can be renamed inline; persists to local storage. */
export function EditableOwnerLabel({ address, label, onSaved, className }: Props) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(label);

  function startEditing() {
    setValue(label);
    setEditing(true);
  }

  function save() {
    const trimmed = value.trim();
    if (!trimmed) {
      setEditing(false);
      return;
    }
    setOwnerLabel(address, trimmed);
    setEditing(false);
    onSaved?.(trimmed);
  }

  function cancel() {
    setValue(label);
    setEditing(false);
  }

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1">
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") cancel();
          }}
          onBlur={save}
          aria-label={`Edit label for ${address}`}
          maxLength={40}
          className="bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-sm text-white w-32 focus:ring-2 focus:ring-zinc-400 focus:outline-none"
        />
        <button
          type="button"
          onClick={save}
          aria-label="Save label"
          className="text-emerald-400 hover:text-emerald-300"
        >
          <Check size={14} />
        </button>
        <button
          type="button"
          onClick={cancel}
          aria-label="Cancel editing label"
          className="text-zinc-600 dark:text-zinc-400 hover:text-zinc-300"
        >
          <X size={14} />
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={startEditing}
      aria-label={`Edit label for ${label}`}
      className={`group inline-flex items-center gap-1.5 text-left ${className ?? ""}`}
    >
      <span>{label}</span>
      <Pencil
        size={12}
        className="text-zinc-600 dark:text-zinc-400 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
      />
    </button>
  );
}
