import { useState, useCallback, useEffect } from "react";
import { getRoles } from "../lib/contract";
import type { Role } from "../types/accord";
import { useEventPolling } from "./useEventPolling";

export function useRoles(address: string | null) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const fetchRoles = useCallback(async () => {
    if (!address) {
      setRoles([]);
      return;
    }
    try {
      const fetchedRoles = await getRoles(address);
      setRoles(fetchedRoles);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch roles");
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    // Reset/clear cached roles when the address changes
    setRoles([]);
    setError(null);
    if (address) {
      setLoading(true);
      fetchRoles();
    } else {
      setLoading(false);
    }
  }, [address, fetchRoles]);

  useEventPolling(fetchRoles, 5000);

  return { roles, loading, error };
}
