import { UserCog } from "lucide-react";
import type { Owner } from "../types/accord";

type OwnersPageProps = {
  owners: Owner[];
  threshold: number;
  totalOwners: number;
  onManageRole: () => void;
};

export function OwnersPage({
  owners,
  threshold,
  totalOwners,
  onManageRole,
}: OwnersPageProps) {
  return (
    <>
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="mb-2 text-2xl font-semibold">Multisig Owners</h1>
          <p className="text-sm text-zinc-400">
            Requires {threshold} of {totalOwners} signers
          </p>
        </div>
        <button
          type="button"
          onClick={onManageRole}
          className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-zinc-400"
        >
          <UserCog size={14} />
          Manage Roles
        </button>
      </div>

      {owners.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-zinc-600 text-sm">No owners found.</p>
        </div>
      ) : (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl divide-y divide-zinc-800">
          {owners.map((owner) => (
            <div
              key={owner.address}
              className="flex items-center gap-3 px-4 py-4"
            >
              <div className="w-7 h-7 rounded-full bg-zinc-700 flex items-center justify-center text-xs text-zinc-400">
                {owner.label[0]}
              </div>
              <div>
                <p className="text-sm text-zinc-300">{owner.label}</p>
                <p className="font-mono text-xs text-zinc-500">{owner.address}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
