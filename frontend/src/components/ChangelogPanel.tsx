import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Sparkles, X } from "lucide-react";
import {
  changelogReleases,
  getChangelogSeen,
  getUnreadEntries,
  markChangelogSeen,
  type ChangelogEntry,
  type ChangelogRelease,
} from "../lib/changelog";

const REPO_URL = "https://github.com/connelevalsam/AccordProtocol";

const LINKABLE_TOKEN =
  /(?<code>`[^`]+`)|(?<issue>#[0-9]{1,7})|(?<doc>docs\/[\w./-]+)/g;

function docLink(path: string, key: number) {
  const clean = path.replace(/[.,;:!?]+$/, "");
  return (
    <a
      key={key}
      href={`${REPO_URL}/blob/main/${clean}`}
      target="_blank"
      rel="noopener noreferrer"
      className="text-emerald-400 transition-colors hover:text-emerald-300 hover:underline"
    >
      {clean}
    </a>
  );
}

/**
 * Renders changelog entry text, turning issue references into GitHub issue
 * links, documentation paths into GitHub file links, and code spans into
 * inline code.
 */
function linkify(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;

  for (const match of text.matchAll(LINKABLE_TOKEN)) {
    const index = match.index ?? 0;
    if (index > last) {
      nodes.push(text.slice(last, index));
    }

    const groups = match.groups ?? {};
    const key = nodes.length;

    if (groups.code) {
      const inner = groups.code.slice(1, -1);
      if (inner.startsWith("docs/")) {
        nodes.push(docLink(inner, key));
      } else {
        nodes.push(
          <code
            key={key}
            className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-[11px] text-zinc-200"
          >
            {inner}
          </code>,
        );
      }
    } else if (groups.issue) {
      nodes.push(
        <a
          key={key}
          href={`${REPO_URL}/issues/${groups.issue.slice(1)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-emerald-400 transition-colors hover:text-emerald-300 hover:underline"
        >
          {groups.issue}
        </a>,
      );
    } else if (groups.doc) {
      nodes.push(docLink(groups.doc, key));
    }

    last = index + match[0].length;
  }

  if (last < text.length) {
    nodes.push(text.slice(last));
  }

  return nodes;
}

function releaseLabel(version: string): string {
  return version === "Unreleased" ? "What's new" : `v${version}`;
}

interface ChangelogPanelProps {
  /** Override the changelog source (used by tests). */
  releases?: ChangelogRelease[];
}

/**
 * "What's new" panel backed by CHANGELOG.md. Shows recent entries grouped by
 * release, links issue references and documentation paths to GitHub, and
 * badges the trigger while entries the user has not opened yet exist. Opening
 * the panel marks everything as seen.
 */
export function ChangelogPanel({ releases = changelogReleases }: ChangelogPanelProps) {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(() => getChangelogSeen());
  const [newAtOpen, setNewAtOpen] = useState<string[]>([]);

  const unreadEntries = getUnreadEntries(releases, seen);
  const unreadIds = new Set(newAtOpen);

  function handleToggle() {
    if (!open) {
      setNewAtOpen(unreadEntries.map((entry) => entry.id));
      setSeen(markChangelogSeen(releases));
    }
    setOpen((v) => !v);
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={handleToggle}
        aria-label={`What's new${unreadEntries.length > 0 ? `, ${unreadEntries.length} unread ${unreadEntries.length === 1 ? "entry" : "entries"}` : ""}`}
        aria-expanded={open}
        className="relative inline-flex items-center justify-center rounded-lg p-2 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-zinc-400"
      >
        <Sparkles size={18} />
        {unreadEntries.length > 0 && (
          <span
            data-testid="changelog-unread-badge"
            className="absolute -top-0.5 -end-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-emerald-500 px-1 text-[10px] font-semibold text-black"
          >
            {unreadEntries.length > 99 ? "99+" : unreadEntries.length}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="What's new"
          className="absolute end-0 z-50 mt-2 w-96 max-w-[calc(100vw-2rem)] rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl"
        >
          <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2.5">
            <h3 className="text-sm font-semibold text-zinc-200">What's new</h3>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close what's new"
              className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-zinc-400"
            >
              <X size={14} />
            </button>
          </div>

          <div className="max-h-96 overflow-y-auto">
            {releases.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-zinc-600 dark:text-zinc-400">
                No changelog entries yet.
              </p>
            ) : (
              <ul className="divide-y divide-zinc-800">
                {releases.map((release) => (
                  <li key={release.version} className="px-3 py-2.5">
                    <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-400">
                      {releaseLabel(release.version)}
                    </p>
                    {release.entries.length === 0 ? (
                      <p className="text-xs text-zinc-600 dark:text-zinc-400">No entries.</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {release.entries.map((entry: ChangelogEntry) => (
                          <li
                            key={entry.id}
                            className={`flex gap-2 rounded px-1 py-0.5 text-xs leading-relaxed ${
                              unreadIds.has(entry.id) ? "bg-zinc-800/40" : ""
                            }`}
                          >
                            {unreadIds.has(entry.id) && (
                              <span
                                aria-label="New"
                                className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400"
                              />
                            )}
                            <span className="text-zinc-300">{linkify(entry.text)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex items-center justify-between border-t border-zinc-800 px-3 py-2.5">
            <a
              href={`${REPO_URL}/blob/main/CHANGELOG.md`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-emerald-400 transition-colors hover:text-emerald-300 hover:underline"
            >
              View full changelog
            </a>
            <Link
              to="/docs"
              className="text-xs text-zinc-400 transition-colors hover:text-zinc-200"
            >
              Documentation
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
