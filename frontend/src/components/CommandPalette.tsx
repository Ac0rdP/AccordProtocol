import { useEffect, useMemo, useRef, useState } from "react";
import {
  searchCommands,
  groupCommands,
  isTypingTarget,
  type Command,
  type CommandGroup,
} from "../lib/commandPalette";

const GROUP_LABELS: Record<CommandGroup, string> = {
  navigate: "Navigate",
  action: "Actions",
};

const FOCUSABLE_SELECTORS =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

type Props = {
  commands: Command[];
  /** When true, the open shortcuts are ignored — set while another modal is open. */
  suspended?: boolean;
};

/**
 * Keyboard-driven command palette: opened with Cmd/Ctrl+Shift+P or "/" (when
 * not typing elsewhere), lists navigation destinations and actions, filters
 * as you type, and executes the selected command on Enter.
 */
export function CommandPalette({ commands, suspended = false }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const modalRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerElementRef = useRef<HTMLElement | null>(null);

  const results = useMemo(() => searchCommands(query, commands), [query, commands]);
  const grouped = useMemo(() => groupCommands(results), [results]);

  function close() {
    setOpen(false);
    setQuery("");
    setActiveIndex(0);
  }

  function run(command: Command) {
    close();
    command.perform();
  }

  // Global open shortcuts: Cmd/Ctrl+Shift+P, or a bare "/" when not typing.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (suspended) return;
      const isPaletteShortcut =
        (event.key === "p" || event.key === "P") &&
        event.shiftKey &&
        (event.metaKey || event.ctrlKey);
      const isSlashShortcut = event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey;

      if (isPaletteShortcut || (isSlashShortcut && !isTypingTarget(event.target))) {
        event.preventDefault();
        triggerElementRef.current = document.activeElement as HTMLElement | null;
        setOpen(true);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [suspended]);

  // Focus the input on open; restore focus to whatever triggered it on close.
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    } else {
      triggerElementRef.current?.focus?.();
    }
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Focus trap + Escape-to-close while open.
  useEffect(() => {
    const modal = modalRef.current;
    if (!open || !modal) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(modal!.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    modal.addEventListener("keydown", onKeyDown);
    return () => modal.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (results.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((i) => (i + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => (i - 1 + results.length) % results.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const selected = results[activeIndex];
      if (selected) run(selected);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 px-4 pt-[12vh] backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-full max-w-md overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2.5">
          <label htmlFor="command-palette-input" className="sr-only">
            Search commands
          </label>
          <input
            ref={inputRef}
            id="command-palette-input"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Type a command or search…"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls="command-palette-results"
            aria-activedescendant={results[activeIndex] ? `command-${results[activeIndex].id}` : undefined}
            className="w-full bg-transparent text-sm text-white placeholder-zinc-500 focus:outline-none"
          />
          <kbd className="rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 font-mono text-[10px] text-zinc-600 dark:text-zinc-400">
            Esc
          </kbd>
        </div>

        <div
          id="command-palette-results"
          role="listbox"
          aria-label="Commands"
          className="max-h-80 overflow-y-auto"
        >
          {results.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-zinc-600 dark:text-zinc-400">No matching commands.</p>
          ) : (
            (Object.keys(GROUP_LABELS) as CommandGroup[]).map((group) => {
              const items = grouped[group];
              if (items.length === 0) return null;
              return (
                <div key={group} className="border-b border-zinc-800/60 py-1 last:border-b-0">
                  <p className="px-3 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
                    {GROUP_LABELS[group]}
                  </p>
                  <ul>
                    {items.map((command) => {
                      const flatIndex = results.findIndex((r) => r.id === command.id);
                      const active = flatIndex === activeIndex;
                      return (
                        <li key={command.id} id={`command-${command.id}`} role="option" aria-selected={active}>
                          <button
                            type="button"
                            onClick={() => run(command)}
                            onMouseEnter={() => setActiveIndex(flatIndex)}
                            className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors focus:outline-none ${
                              active ? "bg-zinc-800 text-white" : "text-zinc-300 hover:bg-zinc-800/60"
                            }`}
                          >
                            <span className="min-w-0">
                              <span className="block truncate font-medium">{command.title}</span>
                              {command.subtitle && (
                                <span className="block truncate text-xs text-zinc-600 dark:text-zinc-400">{command.subtitle}</span>
                              )}
                            </span>
                            {command.shortcut && (
                              <kbd className="shrink-0 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 font-mono text-[10px] text-zinc-600 dark:text-zinc-400">
                                {command.shortcut}
                              </kbd>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
