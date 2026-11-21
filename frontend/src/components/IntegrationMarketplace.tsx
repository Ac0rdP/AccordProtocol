import { useState } from "react";
import {
  INTEGRATION_CATEGORIES,
  type InstalledIntegration,
  type IntegrationCategory,
  type IntegrationPlugin,
} from "../lib/integrationMarketplace";

type IntegrationMarketplaceProps = {
  plugins: IntegrationPlugin[];
  installs: Record<string, InstalledIntegration>;
  actionError?: string | null;
  onInstall: (plugin: IntegrationPlugin, config: Record<string, string>) => Promise<void>;
  onUninstall: (pluginId: string) => Promise<void>;
};

const CATEGORY_LABELS: Record<IntegrationCategory, string> = {
  notifications: "Notifications",
  accounting: "Accounting",
  treasury_automation: "Treasury Automation",
};

export function IntegrationMarketplace({
  plugins,
  installs,
  actionError,
  onInstall,
  onUninstall,
}: IntegrationMarketplaceProps) {
  const [selectedCategory, setSelectedCategory] = useState<IntegrationCategory | "all">("all");
  const [configuring, setConfiguring] = useState<IntegrationPlugin | null>(null);
  const [draftConfig, setDraftConfig] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const visiblePlugins =
    selectedCategory === "all"
      ? plugins
      : plugins.filter((p) => p.category === selectedCategory);

  const openConfigure = (plugin: IntegrationPlugin) => {
    const existing = installs[plugin.id]?.config ?? {};
    const initial: Record<string, string> = {};
    for (const field of plugin.configFields) {
      initial[field.key] = existing[field.key] ?? "";
    }
    setDraftConfig(initial);
    setFormError(null);
    setConfiguring(plugin);
  };

  const handleConfirmInstall = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!configuring) return;
    setFormError(null);
    setSubmitting(true);
    try {
      await onInstall(configuring, draftConfig);
      setConfiguring(null);
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : "Failed to save integration");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Integration categories">
        {INTEGRATION_CATEGORIES.map((cat) => {
          const active = selectedCategory === cat.id;
          return (
            <button
              key={cat.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setSelectedCategory(cat.id)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                active
                  ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900"
                  : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
              }`}
            >
              {cat.label}
            </button>
          );
        })}
      </div>

      {actionError && (
        <div
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
        >
          {actionError}
        </div>
      )}

      {configuring && (
        <form
          onSubmit={handleConfirmInstall}
          aria-label={`Configure ${configuring.name}`}
          className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-zinc-900 dark:text-white">
                Configure {configuring.name}
              </h2>
              <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                Data boundary: {configuring.dataBoundary}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setConfiguring(null)}
              className="text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
            >
              Cancel
            </button>
          </div>

          <div className="mt-4 space-y-3">
            {configuring.configFields.map((field) => (
              <label key={field.key} className="block text-sm">
                <span className="font-medium text-zinc-800 dark:text-zinc-200">
                  {field.label}
                  {field.required ? " *" : ""}
                </span>
                <input
                  type="text"
                  value={draftConfig[field.key] ?? ""}
                  placeholder={field.placeholder}
                  onChange={(e) =>
                    setDraftConfig((prev) => ({ ...prev, [field.key]: e.target.value }))
                  }
                  className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-white"
                />
              </label>
            ))}
          </div>

          {formError && (
            <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
              {formError}
            </p>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {submitting ? "Saving…" : `Save & enable ${configuring.name}`}
            </button>
          </div>
        </form>
      )}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {visiblePlugins.map((plugin) => {
          const installed = installs[plugin.id];
          return (
            <article
              key={plugin.id}
              className="flex flex-col justify-between rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
            >
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                    {CATEGORY_LABELS[plugin.category]}
                  </span>
                  {plugin.reviewed && (
                    <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                      Reviewed v{plugin.version}
                    </span>
                  )}
                </div>

                <h3 className="mt-3 text-base font-semibold text-zinc-900 dark:text-white">
                  {plugin.name}
                </h3>
                <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{plugin.summary}</p>

                <div className="mt-4 space-y-2 rounded-lg bg-zinc-50 p-3 text-xs dark:bg-zinc-950">
                  <div>
                    <span className="font-semibold text-zinc-700 dark:text-zinc-300">
                      Permissions:{" "}
                    </span>
                    <span className="font-mono text-zinc-600 dark:text-zinc-400">
                      {plugin.permissions.join(", ")}
                    </span>
                  </div>
                  <div>
                    <span className="font-semibold text-zinc-700 dark:text-zinc-300">
                      Data boundary:{" "}
                    </span>
                    <span className="text-zinc-600 dark:text-zinc-400">{plugin.dataBoundary}</span>
                  </div>
                </div>
              </div>

              <div className="mt-4 flex items-center justify-between gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
                <span className="text-xs text-zinc-500">By {plugin.publisher}</span>
                {installed ? (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => openConfigure(plugin)}
                      className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
                    >
                      Configure: {plugin.name}
                    </button>
                    <button
                      type="button"
                      onClick={() => onUninstall(plugin.id)}
                      className="rounded-lg border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/40"
                    >
                      Uninstall: {plugin.name}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => openConfigure(plugin)}
                    className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
                  >
                    Install: {plugin.name}
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
