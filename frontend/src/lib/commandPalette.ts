export type CommandGroup = "navigate" | "action";

export type Command = {
  id: string;
  title: string;
  subtitle?: string;
  group: CommandGroup;
  /** Extra terms matched on but not shown, e.g. "proposal transfer payment". */
  keywords?: string[];
  /** Human-readable shortcut hint, e.g. "N". Display only — not bound here. */
  shortcut?: string;
  perform: () => void;
};

function normalize(value: string): string {
  return value.toLowerCase();
}

/** Case-insensitive substring match across a command's title, subtitle, and keywords. */
export function searchCommands(query: string, commands: Command[]): Command[] {
  const trimmed = query.trim();
  if (!trimmed) return commands;
  const needle = normalize(trimmed);
  return commands.filter((command) => {
    const haystack = normalize(
      [command.title, command.subtitle, ...(command.keywords ?? [])].filter(Boolean).join(" "),
    );
    return haystack.includes(needle);
  });
}

export function groupCommands(commands: Command[]): Record<CommandGroup, Command[]> {
  return {
    navigate: commands.filter((command) => command.group === "navigate"),
    action: commands.filter((command) => command.group === "action"),
  };
}

/** True when the given element is where normal typing should not be hijacked by a shortcut. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}
