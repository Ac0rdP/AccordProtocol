import { useEffect, useState } from "react";
import { getActiveDelegations } from "../lib/contract";
import type { Delegation } from "../types/accord";

type DelegationsState = {
  delegations: Delegation[];
  loading: boolean;
  error: string | null;
};

export function useDelegations(ownerAddresses: string[]) {
  const [state, setState] = useState<DelegationsState>({
    delegations: [],
    loading: ownerAddresses.length > 0,
    error: null,
  });
  const [reloadIndex, setReloadIndex] = useState(0);

  const serializedAddresses = ownerAddresses.join(",");

  useEffect(() => {
    let cancelled = false;
    if (ownerAddresses.length === 0) {
      setState({ delegations: [], loading: false, error: null });
      return;
    }

    async function fetchDelegations() {
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const delegations = await getActiveDelegations();
        if (!cancelled) {
          setState({ delegations, loading: false, error: null });
        }
      } catch (err) {
        if (!cancelled) {
          setState({
            delegations: [],
            loading: false,
            error: err instanceof Error ? err.message : "Failed to fetch delegations",
          });
        }
      }
    }

    fetchDelegations();

    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serializedAddresses, reloadIndex]);

  function refetch() {
    setReloadIndex((i) => i + 1);
  }

  return { ...state, refetch };
}
