/** A small, versioned local-storage store shared by history and analytics views. */
export type SavedView<T> = {
  id: string;
  name: string;
  filters: T;
};

function key(scope: string) {
  return `accord_saved_views_${scope}`;
}

export function getSavedViews<T>(scope: string): SavedView<T>[] {
  try {
    const value = localStorage.getItem(key(scope));
    const parsed: unknown = value ? JSON.parse(value) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (view): view is SavedView<T> =>
        Boolean(view) &&
        typeof view === "object" &&
        typeof (view as SavedView<T>).id === "string" &&
        typeof (view as SavedView<T>).name === "string" &&
        "filters" in view,
    );
  } catch {
    return [];
  }
}

export function saveView<T>(scope: string, name: string, filters: T): SavedView<T> {
  const view = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: name.trim(),
    filters,
  };
  try {
    const views = getSavedViews<T>(scope).filter((item) => item.name !== view.name);
    localStorage.setItem(key(scope), JSON.stringify([...views, view]));
  } catch {
    // Saved views are a convenience; rendering must work when storage is unavailable.
  }
  return view;
}

export function removeSavedView(scope: string, id: string) {
  try {
    localStorage.setItem(
      key(scope),
      JSON.stringify(getSavedViews(scope).filter((view) => view.id !== id)),
    );
  } catch {
    // Ignore unavailable or full storage.
  }
}
