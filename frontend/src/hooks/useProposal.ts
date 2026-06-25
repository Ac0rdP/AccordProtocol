import { useState, useEffect } from "react";
import { getProposal } from "../lib/contract";
import type { Proposal } from "../types/accord";

const proposalCache = new Map<number, Proposal>();

export function useProposal(id: number) {
  const [proposal, setProposal] = useState<Proposal | null>(() => proposalCache.get(id) || null);
  const [loading, setLoading] = useState(id > 0 && !proposalCache.has(id));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!Number.isInteger(id) || id <= 0) {
      setProposal(null);
      setLoading(false);
      setError("Invalid proposal identifier");
      return;
    }

    if (proposalCache.has(id)) {
      setProposal(proposalCache.get(id)!);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    getProposal(id)
      .then((data) => {
        if (!cancelled) {
          proposalCache.set(id, data);
          setProposal(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load proposal");
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [id]);

  return { proposal, loading, error };
}
