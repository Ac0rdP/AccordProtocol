import { useCallback, useEffect, useState } from "react";
import {
  getOwners,
  getProposalsPaged,
  getThreshold,
  getTotalProposals,
  mapProposal,
  hasApproved,
} from "../lib/contract";
import type { DashboardStat, Owner, Proposal } from "../types/accord";

type ContractState = {
  proposals: Proposal[];
  owners: Owner[];
  ownerAddresses: string[];
  stats: DashboardStat[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  optimisticUpdate: (id: number, patch: Partial<Proposal>) => void;
  lastSuccessAt: number | null;
};

export function useContract(walletAddress: string | null): ContractState {
  const [tick, setTick] = useState(0);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [owners, setOwners] = useState<Owner[]>([]);
  const [ownerAddresses, setOwnerAddresses] = useState<string[]>([]);
  const [stats, setStats] = useState<DashboardStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const optimisticUpdate = useCallback(
    (id: number, patch: Partial<Proposal>) => {
      setProposals((prev) =>
        prev.map((p) => (p.id === id ? { ...p, ...patch } : p))
      );
    },
    []
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const [ownerAddrs, thresh, total] = await Promise.all([
          getOwners(),
          getThreshold(),
          getTotalProposals(),
        ]);

        const raw = total > 0 ? await getProposalsPaged(0, Math.min(total, 50)) : [];

        if (cancelled) return;

        const mapped = raw.map((p) => mapProposal(p, thresh));

        const proposalsWithApproval = await Promise.all(
          mapped.map(async (p) => {
            if (!walletAddress) {
              return { ...p, userHasApproved: false };
            }
            try {
              const approved = await hasApproved(walletAddress, p.id);
              return { ...p, userHasApproved: approved };
            } catch (err) {
              console.error(`Failed to fetch approval for ${p.id}`, err);
              return { ...p, userHasApproved: false };
            }
          })
        );

        if (cancelled) return;

        setProposals(proposalsWithApproval);
        setOwnerAddresses(ownerAddrs);
        setOwners(
          ownerAddrs.map((addr, i) => ({
            address: `${addr.slice(0, 6)}...${addr.slice(-4)}`,
            label: addr === walletAddress ? "You" : `Signer ${i + 1}`,
          }))
        );

        const active = proposalsWithApproval.filter((p) =>
          ["pending", "ready"].includes(p.status)
        ).length;
        const executed = proposalsWithApproval.filter((p) => p.status === "executed").length;

        setStats([
          {
            label: "Threshold",
            value: `${thresh} of ${ownerAddrs.length}`,
            sub: "signers required",
          },
          { label: "Active", value: String(active), sub: "proposals" },
          { label: "Total", value: String(total), sub: "proposals created" },
          { label: "Executed", value: String(executed), sub: "all time" },
        ]);
        
        if (!cancelled) {
          setLastSuccessAt(Date.now());
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load contract data"
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [tick, walletAddress]);

  return {
    proposals,
    owners,
    ownerAddresses,
    stats,
    loading,
    error,
    refresh,
    optimisticUpdate,
    lastSuccessAt,
  };
}
