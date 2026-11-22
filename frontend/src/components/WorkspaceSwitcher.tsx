import type { Workspace } from "../lib/workspaces";

type WorkspaceSwitcherProps = {
  workspaces: Workspace[];
  activeContractId: string;
  onSelect: (contractId: string) => void;
};

export function WorkspaceSwitcher({
  workspaces,
  activeContractId,
  onSelect,
}: WorkspaceSwitcherProps) {
  if (workspaces.length === 0) return null;

  const active =
    workspaces.find((workspace) => workspace.contractId === activeContractId) ??
    workspaces[0];

  return (
    <label className="flex min-w-0 items-center gap-2 text-xs text-zinc-500">
      <span className="hidden sm:inline">Workspace</span>
      <select
        aria-label="Active workspace"
        value={active.contractId}
        onChange={(event) => onSelect(event.target.value)}
        className="max-w-44 rounded-lg border border-zinc-700 bg-white px-2 py-1.5 font-medium text-zinc-800 outline-none focus:ring-2 focus:ring-emerald-500 dark:bg-zinc-900 dark:text-zinc-100"
      >
        {workspaces.map((workspace) => (
          <option key={workspace.contractId} value={workspace.contractId}>
            {workspace.name}
          </option>
        ))}
      </select>
    </label>
  );
}
