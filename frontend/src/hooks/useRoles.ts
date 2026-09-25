import { useMemo } from "react";

export type WalletRole = "Owner" | "Viewer" | "Guardian" | "SpendingLimit";

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

    const roles = rolesValue
      .split("|")
      .map(parseRole)
      .filter((role): role is WalletRole => role !== null);

    if (roles.length > 0) {
      assignments[normalizedAddress] = roles;
    }

    return assignments;
  }, {});
}

const CONFIGURED_VIEWER_ADDRESSES = parseAddressList(
  import.meta.env.VITE_VIEWER_ADDRESSES
);
const CONFIGURED_ROLE_ASSIGNMENTS = parseRoleAssignments(
  import.meta.env.VITE_ROLE_ASSIGNMENTS
);

function uniqueRoles(roles: WalletRole[]): WalletRole[] {
  return Array.from(new Set(roles));
}

function formatRoleList(roles: WalletRole[]): string {
  const labels = roles.map((role) => ROLE_LABELS[role]);
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

export function getWalletRoles({
  walletAddress,
  ownerAddresses,
  viewerAddresses = CONFIGURED_VIEWER_ADDRESSES,
  roleAssignments = CONFIGURED_ROLE_ASSIGNMENTS,
}: UseRolesArgs): WalletRole[] {
  if (!walletAddress) return [];

  const normalizedWallet = normalizeAddress(walletAddress);
  const roles: WalletRole[] = [];

  if (ownerAddresses.map(normalizeAddress).includes(normalizedWallet)) {
    roles.push("Owner");
  }

  if (viewerAddresses.map(normalizeAddress).includes(normalizedWallet)) {
    roles.push("Viewer");
  }

  const assignedRoles = roleAssignments[normalizedWallet] ?? [];
  roles.push(...assignedRoles);

  return uniqueRoles(roles);
}

export function getRoleAccessBanner({
  walletAddress,
  roles,
  loading = false,
  error = null,
}: {
  walletAddress: string | null;
  roles: WalletRole[];
  loading?: boolean;
  error?: string | null;
}): RoleAccessBanner | null {
  if (!walletAddress || loading || error) return null;
  if (roles.includes("Owner")) return null;

  const nonViewerRoles = roles.filter((role) => role !== "Viewer");

  if (roles.includes("Viewer") && nonViewerRoles.length === 0) {
    return {
      key: `viewer:${walletAddress}`,
      variant: "viewer",
      title: "Viewer access",
      message:
        "This wallet is recognized as a Viewer. You can inspect activity, but you cannot create, approve, or execute proposals.",
    };
  }

  if (nonViewerRoles.length > 0) {
    const roleList = formatRoleList(nonViewerRoles);
    return {
      key: `role-holder:${walletAddress}:${nonViewerRoles.join("|")}`,
      variant: "role-holder",
      title: "Limited role access",
      message: `This wallet holds ${roleList}. You can use role-specific permissions, but owner-only proposal actions are unavailable.`,
    };
  }

  return {
    key: `unrecognized:${walletAddress}`,
    variant: "unrecognized",
    title: "Unrecognized wallet",
    message:
      "This wallet is not assigned a role in this Accord. You can view public activity, but protected actions are unavailable.",
  };
}

export function useRoles(args: UseRolesArgs): WalletRoles {
  const {
    walletAddress,
    ownerAddresses,
    viewerAddresses = CONFIGURED_VIEWER_ADDRESSES,
    roleAssignments = CONFIGURED_ROLE_ASSIGNMENTS,
    loading = false,
    error = null,
  } = args;

  const roles = useMemo(
    () =>
      getWalletRoles({
        walletAddress,
        ownerAddresses,
        viewerAddresses,
        roleAssignments,
      }),
    [walletAddress, ownerAddresses, viewerAddresses, roleAssignments]
  );

  const banner = useMemo(
    () => getRoleAccessBanner({ walletAddress, roles, loading, error }),
    [walletAddress, roles, loading, error]
  );

  return { roles, banner };
}
