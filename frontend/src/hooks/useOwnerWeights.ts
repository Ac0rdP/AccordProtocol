import { useEffect, useState } from "react";
import { getOwnerWeights } from "../lib/contract";

type OwnerWeightState = {
  weights: Record<string, number>;
  totalWeight: number;
  loading: boolean;
  error: string | null;
};

export function useOwnerWeights(ownerAddresses: string[]) {
  const [state, setState] = useState<OwnerWeightState>({
    weights: {},
    totalWeight: 0,
    loading: ownerAddresses.length > 0,
    error: null,
  });

  const serializedAddresses = ownerAddresses.join(",");

  useEffect(() => {
    let cancelled = false;
    if (ownerAddresses.length === 0) {
      const timer = setTimeout(() => {
        if (!cancelled) {
          setState({
            weights: {},
            totalWeight: 0,
            loading: false,
            error: null,
          });
        }
      }, 0);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    }

    async function fetchWeights() {
      setState((s: OwnerWeightState) => ({ ...s, loading: true, error: null }));
      try {
        const results = await getOwnerWeights();
        if (cancelled) return;

        const weightMap: Record<string, number> = {};
        let sum = 0;
        for (const res of results) {
          weightMap[res.address] = res.weight;
          sum += res.weight;
        }

        setState({
          weights: weightMap,
          totalWeight: sum,
          loading: false,
          error: null,
        });
      } catch (err) {
        if (!cancelled) {
          setState({
            weights: {},
            totalWeight: 0,
            loading: false,
            error: err instanceof Error ? err.message : "Failed to fetch owner weights",
          });
        }
      }
    }

    fetchWeights();

    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serializedAddresses]);

  return state;
}
