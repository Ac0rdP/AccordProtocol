import { UserCog } from "lucide-react";
import type { Owner, Role } from "../types/accord";

type OwnersPageProps = {
  owners: Owner[];
  threshold: number;
  totalOwners: number;
  onManageRoles: (ownerAddress: string) => void;
};

const ROLE_STYLES: Record<Role, string> = {
  Owner: "border-emerald-500/20 bg-emerald-500/10 text-emerald-300",
  Viewer: "border-sky-500/20 bg-sky-500/10 text-sky-300",
  Guardian: "border-amber-500/20 bg-amber-500/10 text-amber-300",
  SpendingLimit: "border-violet-500/20 bg-violet-500/10 text-violet-300",
};

const ROLE_LABELS: Record<Role, string> = {
  Owner: "Owner",
  Viewer: "Viewer",
  Guardian: "Guardian",
  SpendingLimit: "Spending Limit",
};

function RoleBadge({ role }: { role: Role }) {
  return (
    <span
      className={`rounded-md border px-2 py-0.5 text-xs font-medium ${ROLE_STYLES[role]}`}
    >
      {ROLE_LABELS[role]}
    </span>
  );
}

export function OwnersPage({
  owners,
  threshold,
  totalOwners,
  onManageRoles,
}: OwnersPageProps) {
  return (
    <>
      <div className="mb-8">
        <h1 className="mb-2 text-2xl font-semibold">Multisig Owners</h1>
        <p className="text-sm text-zinc-400">
          Requires {threshold} of {totalOwners} signers
        </p>
      </div>

      {owners.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-zinc-600 text-sm">No owners found.</p>
        </div>
      ) : (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl divide-y divide-zinc-800">
          {owners.map((owner) => (
            <div
              key={owner.fullAddress}
              className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex items-start gap-3">
                <div className="w-7 h-7 shrink-0 rounded-full bg-zinc-700 flex items-center justify-center text-xs text-zinc-400">
                  {owner.label[0]}
                </div>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm text-zinc-300">{owner.label}</p>
                    {typeof owner.weight === "number" && (
                      <span className="rounded-md border border-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
                        Weight {owner.weight}
                      </span>
                    )}
                  </div>
                  <p className="font-mono text-xs text-zinc-500">{owner.address}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5" aria-label={`${owner.label} roles`}>
                    {owner.roles.length > 0 ? (
                      owner.roles.map((role) => <RoleBadge key={role} role={role} />)
                    ) : (
                      <span className="rounded-md border border-zinc-800 px-2 py-0.5 text-xs text-zinc-500">
                        No roles
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <button
                type="button"
                onClick={() => onManageRoles(owner.fullAddress)}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-zinc-400 sm:self-center"
              >
                <UserCog size={14} />
                Manage Roles
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
