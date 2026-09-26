import { useMemo } from "react";
import { useState, useCallback, useEffect } from "react";
import { getRoles } from "../lib/contract";
import type { Role } from "../types/accord";
import { useEventPolling } from "./useEventPolling";

export type WalletRole = Role;

export type RoleBannerVariant = "viewer" | "role-holder" | "unrecognized";

export type RoleAccessBanner = {
  key: string;
  variant: RoleBannerVariant;
  title: string;
  message: string;
};

type RoleAssignments = Record<string, WalletRole[]>;

type UseRolesArgs = {
  walletAddress: string | null;
  ownerAddresses: string[];
  viewerAddresses?: string[];
  roleAssignments?: RoleAssignments;
  loading?: boolean;
  error?: string | null;
};

export type WalletRoles = {
  roles: WalletRole[];
  banner: RoleAccessBanner | null;
};

const ROLE_LABELS: Record<WalletRole, string> = {
  Owner: "Owner",
  Viewer: "Viewer",
  Guardian: "Guardian",
  SpendingLimit: "Spending Limit",
  Proposer: "Proposer",
  Approver: "Approver",
  Executor: "Executor",
};

function normalizeAddress(address: string): string {
  return address.trim();
}

function parseAddressList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((address) => normalizeAddress(address))
    .filter(Boolean);
}

function parseRole(role: string): WalletRole | null {
  const normalized = role.trim().toLowerCase();
  switch (normalized) {
    case "owner":
      return "Owner";
    case "viewer":
      return "Viewer";
    case "guardian":
      return "Guardian";
    case "spendinglimit":
    case "spending_limit":
    case "spending-limit":
      return "SpendingLimit";
    case "proposer":
      return "Proposer";
    case "approver":
      return "Approver";
    case "executor":
      return "Executor";
    default:
      return null;
  }
}

function parseRoleAssignments(raw: string | undefined): RoleAssignments {
  if (!raw) return {};

  return raw.split(",").reduce<RoleAssignments>((assignments, entry) => {
    const [address, rolesValue] = entry.split(":");
    const normalizedAddress = normalizeAddress(address ?? "");
    if (!normalizedAddress || !rolesValue) return assignments;
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
