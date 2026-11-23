import { useState, useEffect } from "react";
import { getProposal, getProposalApprovalProgress } from "../lib/contract";
import { getActiveContractId } from "../lib/activeContract";
import type { Proposal } from "../types/accord";

const proposalCache = new Map<string, Proposal>();

export function useProposal(id: number) {
  const contractId = getActiveContractId();
  const cacheKey = `${contractId}:${id}`;
  const [proposal, setProposal] = useState<Proposal | null>(
    () => proposalCache.get(cacheKey) || null,
  );
  const [loading, setLoading] = useState(id > 0 && !proposalCache.has(cacheKey));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!Number.isInteger(id) || id <= 0) {
      setProposal(null);
      setLoading(false);
      setError("Invalid proposal identifier");
      return;
    }

    if (proposalCache.has(cacheKey)) {
      setProposal(proposalCache.get(cacheKey)!);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    // Merge approval-progress (approvalWeight, quorumWeight, totalWeight) into the
    // proposal object so consumers get the weight data through the same `proposal`
    // field without changing the hook's { proposal, loading, error } return shape.
    getProposal(id)
      .then(async (data) => {
        if (cancelled) return;

        let approvalWeight = 0;
        let quorumWeight = 0;
        let totalWeight = 0;

        try {
          const progress = await getProposalApprovalProgress(id);
          approvalWeight = progress.approvalWeight;
          quorumWeight = progress.quorumWeight;
          totalWeight = progress.totalWeight;
        } catch (weightErr) {
          if (!cancelled) {
            setError(
              weightErr instanceof Error
                ? `Weight data unavailable: ${weightErr.message}`
                : "Weight data unavailable",
            );
          }
        }

        const merged: Proposal = {
          ...data,
          approvalWeight,
          quorumWeight,
          totalWeight,
        };

        if (!cancelled) {
          proposalCache.set(cacheKey, merged);
          setProposal(merged);
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
  }, [cacheKey, id]);

  return { proposal, loading, error };
}
