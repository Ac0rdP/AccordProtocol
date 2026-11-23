import { useCallback, useState } from "react";
import {
  readAvailabilityMap,
  resetAvailabilityStorage,
  saveOwnerAvailability,
  type AvailabilityMap,
  type AvailabilityWindow,
} from "../lib/ownerAvailability";

type LoadResult = { availability: AvailabilityMap; error: string | null };

function load(): LoadResult {
  try {
    return { availability: readAvailabilityMap(), error: null };
  } catch (err) {
    return {
      availability: {},
      error: err instanceof Error ? err.message : "Could not read saved availability",
    };
  }
}

export function useOwnerAvailability() {
  const [state, setState] = useState<LoadResult>(load);

  const retry = useCallback(() => setState(load()), []);

  const reset = useCallback(() => {
    resetAvailabilityStorage();
    setState(load());
  }, []);

  /** Persists one owner's windows. Throws a user-facing error on failure. */
  const save = useCallback(
    (address: string, windows: AvailabilityWindow[]) => {
      const availability = saveOwnerAvailability(state.availability, address, windows);
      setState({ availability, error: null });
    },
    [state.availability],
  );

  return { availability: state.availability, error: state.error, retry, reset, save };
}
