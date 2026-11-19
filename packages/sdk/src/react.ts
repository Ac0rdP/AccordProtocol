/**
 * Reusable React Hooks for Accord Protocol SDK.
 * Supports proposals, owners, analytics, and transaction submission.
 */

import type { AccordClient } from "./client.js";
import type { Proposal, ProposalFilter } from "./types.js";

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<T | null>;
}

export interface ProposalActionState {
  approve: (proposalId: number) => Promise<boolean>;
  execute: (proposalId: number) => Promise<boolean>;
  loading: boolean;
  error: Error | null;
}

/**
 * Hook to retrieve or instantiate an AccordClient.
 */
export function useAccordClient(client: AccordClient): AccordClient {
  return client;
}

/**
 * Hook to load and watch multisig owner addresses.
 */
export function useOwners(client?: Pick<AccordClient, "getOwners">): AsyncState<string[]> {
  let data: string[] | null = null;
  let loading = true;
  let error: Error | null = null;

  const refetch = async (): Promise<string[] | null> => {
    if (!client) {
      loading = false;
      return null;
    }
    loading = true;
    error = null;
    try {
      data = await client.getOwners();
      return data;
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
      return null;
    } finally {
      loading = false;
    }
  };

  return {
    data,
    loading,
    error,
    refetch,
  };
}

/**
 * Hook to query a single proposal by ID.
 */
export function useProposal(
  client?: Pick<AccordClient, "getProposal">,
  proposalId?: number
): AsyncState<Proposal> {
  let data: Proposal | null = null;
  let loading = true;
  let error: Error | null = null;

  const refetch = async (): Promise<Proposal | null> => {
    if (!client || proposalId === undefined) {
      loading = false;
      return null;
    }
    loading = true;
    error = null;
    try {
      data = await client.getProposal(proposalId);
      return data;
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
      return null;
    } finally {
      loading = false;
    }
  };

  return {
    data,
    loading,
    error,
    refetch,
  };
}

/**
 * Hook to list proposals with optional filtering.
 */
export function useProposals(
  client?: Pick<AccordClient, "getProposals">,
  filter?: ProposalFilter
): AsyncState<Proposal[]> {
  let data: Proposal[] | null = null;
  let loading = true;
  let error: Error | null = null;

  const refetch = async (): Promise<Proposal[] | null> => {
    if (!client) {
      loading = false;
      return null;
    }
    loading = true;
    error = null;
    try {
      data = await client.getProposals(filter);
      return data;
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
      return null;
    } finally {
      loading = false;
    }
  };

  return {
    data,
    loading,
    error,
    refetch,
  };
}

/**
 * Hook to dispatch state-changing actions (approve, execute).
 */
export function useProposalActions(
  client?: Pick<AccordClient, "approveProposal" | "executeProposal">
): ProposalActionState {
  let loading = false;
  let error: Error | null = null;

  const approve = async (proposalId: number): Promise<boolean> => {
    if (!client) throw new Error("Client not provided");
    loading = true;
    error = null;
    try {
      await client.approveProposal(proposalId);
      return true;
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
      throw error;
    } finally {
      loading = false;
    }
  };

  const execute = async (proposalId: number): Promise<boolean> => {
    if (!client) throw new Error("Client not provided");
    loading = true;
    error = null;
    try {
      await client.executeProposal(proposalId);
      return true;
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
      throw error;
    } finally {
      loading = false;
    }
  };

  return {
    approve,
    execute,
    loading,
    error,
  };
}
