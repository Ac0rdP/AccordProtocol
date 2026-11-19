import { useState, type FormEvent } from "react";
import type { SavedView } from "../lib/savedViews";

type SavedViewsProps<T> = {
  label: string;
  views: SavedView<T>[];
  onApply: (filters: T) => void;
  onSave: (name: string) => void;
  onRemove: (id: string) => void;
};

/** Keyboard-friendly named presets for a page's current filters. */
export function SavedViews<T>({ label, views, onApply, onSave, onRemove }: SavedViewsProps<T>) {
  const [name, setName] = useState("");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!name.trim()) return;
    onSave(name);
    setName("");
  };

  return (
    <section aria-label={`${label} saved views`} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">Saved views</p>
        <form onSubmit={submit} className="flex gap-2">
          <label className="sr-only" htmlFor={`${label}-saved-view-name`}>Name this view</label>
          <input
            id={`${label}-saved-view-name`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={60}
            placeholder="Name this view"
            className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-400"
          />
          <button type="submit" disabled={!name.trim()} className="rounded-md bg-zinc-700 px-3 py-1 text-xs font-medium text-white hover:bg-zinc-600 focus:outline-none focus:ring-2 focus:ring-zinc-400 disabled:cursor-not-allowed disabled:opacity-50">
            Save view
          </button>
        </form>
      </div>
      {views.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-2" aria-label="Saved filter views">
          {views.map((view) => (
            <li key={view.id} className="inline-flex overflow-hidden rounded-md border border-zinc-700">
              <button type="button" onClick={() => onApply(view.filters)} className="px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-zinc-400">
                {view.name}
              </button>
              <button type="button" onClick={() => onRemove(view.id)} aria-label={`Delete saved view ${view.name}`} className="border-l border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-white focus:outline-none focus:ring-2 focus:ring-inset focus:ring-zinc-400">
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="mt-2 text-xs text-zinc-500">Save the current filters to reuse them later.</p>}
    </section>
  );
}
