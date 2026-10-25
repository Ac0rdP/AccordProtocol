import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { Owner, Proposal, RecurringSchedule } from "../types/accord";
import {
  buildRecipientIndex,
  groupSearchResults,
  searchGlobal,
  type SearchResult,
  type SearchResultGroup,
} from "../lib/globalSearch";

const GROUP_LABELS: Record<SearchResultGroup, string> = {
  proposals: "Proposals",
  owners: "Owners",
  recipients: "Recipients",
};

type GlobalSearchProps = {
  proposals: Proposal[];
  owners: Owner[];
  schedules?: RecurringSchedule[];
};

export function GlobalSearch({
  proposals,
  owners,
  schedules = [],
}: GlobalSearchProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const index = useMemo(
    () => ({
      proposals,
      owners,
      recipients: buildRecipientIndex(proposals, schedules),
    }),
    [proposals, owners, schedules],
  );

  const results = useMemo(
    () => searchGlobal(query, index),
    [query, index],
  );
  const grouped = useMemo(() => groupSearchResults(results), [results]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const isShortcut =
        (event.key === "k" || event.key === "K") &&
        (event.metaKey || event.ctrlKey);
      if (isShortcut) {
        event.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
      if (event.key === "Escape") {
        setOpen(false);
        inputRef.current?.blur();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  function goTo(result: SearchResult) {
    setOpen(false);
    setQuery("");
    navigate(result.to);
  }

  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || results.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((i) => (i + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => (i - 1 + results.length) % results.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const selected = results[activeIndex];
      if (selected) goTo(selected);
    }
  }

  const showPanel = open && query.trim().length > 0;

  return (
    <div ref={rootRef} className="relative hidden min-w-0 flex-1 md:block md:max-w-xs lg:max-w-sm">
      <label htmlFor="global-search" className="sr-only">
        Search proposals, owners, and recipients
      </label>
      <div className="relative">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
          className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-zinc-400"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.602 10.602Z"
          />
        </svg>
        <input
          ref={inputRef}
          id="global-search"
          type="search"
          role="combobox"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onInputKeyDown}
          placeholder="Search…"
          aria-autocomplete="list"
          aria-controls="global-search-results"
          aria-expanded={showPanel}
          className="w-full rounded-lg border border-zinc-800 bg-zinc-900 py-1.5 pl-8 pr-12 text-sm text-white placeholder-zinc-400 focus:border-zinc-700 focus:outline-none focus:ring-2 focus:ring-zinc-400"
        />
        <kbd className="pointer-events-none absolute right-2 top-1.5 hidden rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400 sm:inline">
          ⌘K
        </kbd>
      </div>

      {showPanel && (
        <div
          id="global-search-results"
          role="listbox"
          aria-label="Search results"
          className="absolute left-0 right-0 z-50 mt-2 max-h-80 overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-950 shadow-xl"
        >
          {results.length === 0 ? (
            <p className="px-3 py-4 text-center text-sm text-zinc-400">
              No matches for “{query.trim()}”
            </p>
          ) : (
            (Object.keys(GROUP_LABELS) as SearchResultGroup[]).map((group) => {
              const items = grouped[group];
              if (items.length === 0) return null;
              return (
                <div key={group} className="border-b border-zinc-900 last:border-b-0">
                  <p className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                    {GROUP_LABELS[group]}
                  </p>
                  <ul>
                    {items.map((item) => {
                      const flatIndex = results.findIndex((r) => r.id === item.id);
                      const active = flatIndex === activeIndex;
                      return (
                        <li key={item.id} role="option" aria-selected={active}>
                          <Link
                            to={item.to}
                            onClick={() => {
                              setOpen(false);
                              setQuery("");
                            }}
                            className={`block px-3 py-2 text-sm transition-colors focus:outline-none ${
                              active
                                ? "bg-zinc-800 text-white"
                                : "text-zinc-300 hover:bg-zinc-900"
                            }`}
                          >
                            <span className="block truncate font-medium">
                              {item.title}
                            </span>
                            <span className="block truncate text-xs text-zinc-400">
                              {item.subtitle}
                            </span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
