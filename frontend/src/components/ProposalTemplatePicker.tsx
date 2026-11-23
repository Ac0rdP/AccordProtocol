import { useState } from "react";
import { BookmarkPlus, Pencil, Check, X, Trash2 } from "lucide-react";
import { useProposalTemplates } from "../hooks/useProposalTemplates";
import type { ProposalTemplateFields } from "../lib/proposalTemplates";

type Props = {
  /** Current form values offered when the user saves a new template. */
  fields: ProposalTemplateFields;
  /** Called with a template's fields when the user picks one to load. */
  onApply: (fields: ProposalTemplateFields) => void;
  idPrefix: string;
};

/**
 * A saved-template dropdown plus save/rename/delete management, shared by
 * the proposal and recurring-payment creation modals.
 */
export function ProposalTemplatePicker({ fields, onApply, idPrefix }: Props) {
  const { templates, save, rename, remove } = useProposalTemplates();
  const [manageOpen, setManageOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  function handleSelect(templateId: string) {
    if (!templateId) return;
    const template = templates.find((t) => t.id === templateId);
    if (template) onApply(template.fields);
  }

  function handleSaveClick() {
    setName("");
    setSaving(true);
  }

  function handleConfirmSave() {
    if (!name.trim()) return;
    save(name.trim(), fields);
    setSaving(false);
  }

  function startRename(id: string, currentName: string) {
    setRenamingId(id);
    setRenameValue(currentName);
  }

  function confirmRename() {
    if (renamingId && renameValue.trim()) {
      rename(renamingId, renameValue.trim());
    }
    setRenamingId(null);
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        {templates.length > 0 && (
          <select
            id={`${idPrefix}-template`}
            aria-label="Load a saved template"
            value=""
            onChange={(e) => handleSelect(e.target.value)}
            className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-zinc-300 focus:ring-2 focus:ring-zinc-400 focus:outline-none focus:border-zinc-500"
          >
            <option value="">Load a saved template…</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          onClick={() => setManageOpen((v) => !v)}
          className="text-xs text-zinc-400 hover:text-zinc-200 whitespace-nowrap"
        >
          {manageOpen ? "Close" : "Manage templates"}
        </button>
      </div>

      {!saving && (
        <button
          type="button"
          onClick={handleSaveClick}
          className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-emerald-400 transition-colors"
        >
          <BookmarkPlus size={13} />
          Save as template
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
              if (e.key === "Escape") setSaving(false);
            }}
            placeholder="Template name"
            aria-label="Template name"
            maxLength={60}
            className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-zinc-600 focus:ring-2 focus:ring-zinc-400 focus:outline-none"
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
            onClick={() => setSaving(false)}
            className="text-xs text-zinc-600 dark:text-zinc-400 hover:text-zinc-300"
          >
            Cancel
          </button>
        </div>
      )}

      {manageOpen && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2 space-y-1.5">
          {templates.length === 0 ? (
            <p className="text-xs text-zinc-600 dark:text-zinc-400 px-1">No saved templates yet.</p>
          ) : (
            templates.map((template) => (
              <div key={template.id} className="flex items-center justify-between gap-2 px-1">
                {renamingId === template.id ? (
                  <span className="flex flex-1 items-center gap-1">
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") confirmRename();
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                      aria-label={`Rename template ${template.name}`}
                      maxLength={60}
                      className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-xs text-white focus:ring-2 focus:ring-zinc-400 focus:outline-none"
                    />
                    <button type="button" onClick={confirmRename} aria-label="Save name" className="text-emerald-400 hover:text-emerald-300">
                      <Check size={13} />
                    </button>
                    <button type="button" onClick={() => setRenamingId(null)} aria-label="Cancel rename" className="text-zinc-600 dark:text-zinc-400 hover:text-zinc-300">
                      <X size={13} />
                    </button>
                  </span>
                ) : (
                  <>
                    <span className="text-xs text-zinc-300 truncate">{template.name}</span>
                    <span className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => startRename(template.id, template.name)}
                        aria-label={`Rename template ${template.name}`}
                        className="text-zinc-600 dark:text-zinc-400 hover:text-zinc-300"
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(template.id)}
                        aria-label={`Delete template ${template.name}`}
                        className="text-zinc-600 dark:text-zinc-400 hover:text-red-400"
                      >
                        <Trash2 size={13} />
                      </button>
                    </span>
                  </>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
