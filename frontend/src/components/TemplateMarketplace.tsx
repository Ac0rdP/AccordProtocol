import { useId, useMemo, useState } from "react";
import { useDialogFocus } from "../hooks/useDialogFocus";
import {
  MARKETPLACE_CATEGORIES,
  filterTemplates,
  getInstallState,
  type InstallState,
  type InstalledMarketplaceTemplate,
  type MarketplaceFilter,
  type MarketplaceTemplate,
} from "../lib/templateMarketplace";
import { EmptyState } from "./EmptyState";

const FOCUS_RING =
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950";

const FIELD_LABELS: Record<string, string> = {
  kind: "Proposal type",
  recipient: "Recipient",
  amount: "Amount",
  token: "Token",
  description: "Description",
  category: "Category",
  interval: "Interval (seconds)",
  cliff: "Cliff",
  endDate: "End date",
  cap: "Cap",
};

function installLabel(state: InstallState, template: MarketplaceTemplate): string {
  if (state === "installed") return "Installed";
  if (state === "update_available") return `Update to v${template.version}`;
  return "Install";
}

function formatUpdated(date: string): string {
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export type TemplateMarketplaceProps = {
  templates: MarketplaceTemplate[];
  installs: Record<string, InstalledMarketplaceTemplate>;
  /** Installs or updates a template. May throw a user-facing error. */
  onInstall: (template: MarketplaceTemplate) => void;
  onUninstall: (marketplaceId: string) => void;
};

/** Browse, filter, preview, and install community proposal templates. */
export function TemplateMarketplace({
  templates,
  installs,
  onInstall,
  onUninstall,
}: TemplateMarketplaceProps) {
  const [filter, setFilter] = useState<MarketplaceFilter>({ query: "", category: "all" });
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const searchId = useId();
  const categoryId = useId();

  const visible = useMemo(() => filterTemplates(templates, filter), [templates, filter]);
  const previewTemplate = templates.find((t) => t.id === previewId) ?? null;

  function handleInstall(template: MarketplaceTemplate) {
    const wasInstalled = Boolean(installs[template.id]);
    try {
      onInstall(template);
      setNotice({
        tone: "success",
        text: wasInstalled
          ? `Updated "${template.name}" to v${template.version}.`
          : `Installed "${template.name}". It is now available in the New Proposal template picker.`,
      });
    } catch (err) {
      setNotice({
        tone: "error",
        text: err instanceof Error ? err.message : "Could not install the template.",
      });
    }
  }

  function handleUninstall(template: MarketplaceTemplate) {
    try {
      onUninstall(template.id);
      setNotice({ tone: "success", text: `Removed "${template.name}" from your templates.` });
    } catch (err) {
      setNotice({
        tone: "error",
        text: err instanceof Error ? err.message : "Could not remove the template.",
      });
    }
  }

  return (
    <div>
      <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_auto]">
        <div>
          <label htmlFor={searchId} className="mb-1 block text-xs text-zinc-400">
            Search templates
          </label>
          <input
            id={searchId}
            type="search"
            value={filter.query}
            onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))}
            placeholder="Name, author, or tag"
            className={`min-h-11 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 ${FOCUS_RING}`}
          />
        </div>
        <div>
          <label htmlFor={categoryId} className="mb-1 block text-xs text-zinc-400">
            Category
          </label>
          <select
            id={categoryId}
            value={filter.category}
            onChange={(e) =>
              setFilter((f) => ({ ...f, category: e.target.value as MarketplaceFilter["category"] }))
            }
            className={`min-h-11 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 sm:w-44 ${FOCUS_RING}`}
          >
            <option value="all">All categories</option>
            {MARKETPLACE_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div aria-live="polite" className="min-h-0">
        {notice && (
          <p
            role={notice.tone === "error" ? "alert" : "status"}
            className={`mb-4 rounded-lg border px-3 py-2 text-sm ${
              notice.tone === "error"
                ? "border-red-500/20 bg-red-500/10 text-red-300"
                : "border-emerald-500/20 bg-emerald-500/10 text-emerald-300"
            }`}
          >
            {notice.text}
          </p>
        )}
      </div>

      <p className="mb-3 text-xs text-zinc-400">
        Showing {visible.length} of {templates.length} templates
      </p>

      {visible.length === 0 ? (
        <EmptyState
          variant="section"
          title="No templates match your filters"
          description="Try a different search term or category."
          action={
            <button
              type="button"
              onClick={() => setFilter({ query: "", category: "all" })}
              className={`min-h-11 rounded-lg bg-zinc-800 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-700 ${FOCUS_RING}`}
            >
              Clear filters
            </button>
          }
        />
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((template) => {
            const state = getInstallState(template, installs);
            const installed = installs[template.id];
            return (
              <li
                key={template.id}
                className="flex flex-col rounded-xl border border-zinc-800 bg-zinc-900 p-4"
              >
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">
                    {template.category}
                  </span>
                  <span className="font-mono text-xs text-zinc-400">v{template.version}</span>
                  {state === "update_available" && installed && (
                    <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-300">
                      v{installed.version} installed
                    </span>
                  )}
                </div>
                <h3 className="text-sm font-semibold text-zinc-100">{template.name}</h3>
                <p className="mt-1 flex-1 text-sm text-zinc-400">{template.summary}</p>
                <p className="mt-3 text-xs text-zinc-500">
                  By {template.author} · Updated {formatUpdated(template.updatedAt)}
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setPreviewId(template.id)}
                    aria-label={`Preview ${template.name}`}
                    className={`min-h-11 flex-1 rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-700 ${FOCUS_RING}`}
                  >
                    Preview
                  </button>
                  <button
                    type="button"
                    onClick={() => handleInstall(template)}
                    disabled={state === "installed"}
                    aria-label={`${installLabel(state, template)}: ${template.name}`}
                    className={`min-h-11 flex-1 rounded-lg px-3 py-2 text-sm font-medium disabled:cursor-default ${
                      state === "installed"
                        ? "bg-emerald-500/10 text-emerald-300"
                        : "bg-emerald-600 text-white hover:bg-emerald-500"
                    } ${FOCUS_RING}`}
                  >
                    {installLabel(state, template)}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {previewTemplate && (
        <TemplatePreviewDialog
          template={previewTemplate}
          state={getInstallState(previewTemplate, installs)}
          installedVersion={installs[previewTemplate.id]?.version}
          onInstall={() => handleInstall(previewTemplate)}
          onUninstall={() => handleUninstall(previewTemplate)}
          onClose={() => setPreviewId(null)}
        />
      )}
    </div>
  );
}

type TemplatePreviewDialogProps = {
  template: MarketplaceTemplate;
  state: InstallState;
  installedVersion?: string;
  onInstall: () => void;
  onUninstall: () => void;
  onClose: () => void;
};

export function TemplatePreviewDialog({
  template,
  state,
  installedVersion,
  onInstall,
  onUninstall,
  onClose,
}: TemplatePreviewDialogProps) {
  const { dialogRef, onKeyDown } = useDialogFocus(onClose);
  const titleId = useId();
  const descriptionId = useId();
  const fieldEntries = Object.entries(template.fields).filter(
    ([, value]) => value !== undefined && value !== "",
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="max-h-[90vh] w-full overflow-y-auto rounded-t-2xl border border-zinc-700 bg-zinc-900 p-4 text-zinc-100 sm:max-w-lg sm:rounded-2xl sm:p-6"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-semibold">
              {template.name}
            </h2>
            <p className="text-xs text-zinc-400">
              {template.category} · v{template.version} · by {template.author}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close preview"
            className={`min-h-11 min-w-11 rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 ${FOCUS_RING}`}
          >
            ✕
          </button>
        </div>

        <p id={descriptionId} className="mb-4 text-sm text-zinc-300">
          {template.description}
        </p>

        <h3 className="mb-2 text-xs uppercase tracking-wide text-zinc-400">Pre-filled fields</h3>
        <dl className="mb-4 divide-y divide-zinc-800 rounded-lg border border-zinc-800 text-sm">
          {fieldEntries.map(([key, value]) => (
            <div key={key} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-2 px-3 py-2">
              <dt className="text-zinc-400">{FIELD_LABELS[key] ?? key}</dt>
              <dd className="wrap-break-word font-mono text-zinc-100">{value}</dd>
            </div>
          ))}
        </dl>

        <h3 className="mb-2 text-xs uppercase tracking-wide text-zinc-400">Version</h3>
        <dl className="mb-4 grid grid-cols-2 gap-2 text-sm">
          <dt className="text-zinc-400">Latest</dt>
          <dd>v{template.version}</dd>
          <dt className="text-zinc-400">Installed</dt>
          <dd>{installedVersion ? `v${installedVersion}` : "Not installed"}</dd>
          <dt className="text-zinc-400">Published</dt>
          <dd>{formatUpdated(template.updatedAt)}</dd>
        </dl>
        {template.changelog && (
          <p className="mb-4 rounded-lg bg-zinc-800/60 px-3 py-2 text-sm text-zinc-300">
            <span className="font-medium">What&apos;s new: </span>
            {template.changelog}
          </p>
        )}
        {template.tags.length > 0 && (
          <ul className="mb-5 flex flex-wrap gap-1.5" aria-label="Tags">
            {template.tags.map((tag) => (
              <li key={tag} className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
                #{tag}
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {state !== "not_installed" && (
            <button
              type="button"
              onClick={onUninstall}
              className={`min-h-11 rounded-lg bg-zinc-800 px-4 py-2 text-sm text-red-300 hover:bg-zinc-700 ${FOCUS_RING}`}
            >
              Uninstall
            </button>
          )}
          <button
            type="button"
            onClick={onInstall}
            disabled={state === "installed"}
            className={`min-h-11 rounded-lg px-4 py-2 text-sm font-medium disabled:cursor-default ${
              state === "installed"
                ? "bg-emerald-500/10 text-emerald-300"
                : "bg-emerald-600 text-white hover:bg-emerald-500"
            } ${FOCUS_RING}`}
          >
            {installLabel(state, template)}
          </button>
        </div>
      </div>
    </div>
  );
}
