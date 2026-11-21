/**
 * Reviewed plugin and integration marketplace for notifications, accounting,
 * and treasury automation.
 *
 * Common-path usability: works out-of-the-box using the reviewed bundled
 * catalog + local workspace persistence when no analytics API URL is
 * configured, and syncs with `GET/PUT/DELETE /integrations` when
 * `VITE_ANALYTICS_API_URL` is set.
 *
 * Security & data boundary: integrations never receive wallet private keys or
 * bypass multisig quorum. Every catalog entry declares explicit permissions
 * and a human-readable data boundary.
 */

export type IntegrationCategory =
  | "notifications"
  | "accounting"
  | "treasury_automation";

export type ConfigFieldSpec = {
  key: string;
  label: string;
  required: boolean;
  placeholder: string;
};

export type IntegrationPlugin = {
  id: string;
  name: string;
  category: IntegrationCategory;
  summary: string;
  description: string;
  version: string;
  publisher: string;
  reviewed: boolean;
  permissions: string[];
  dataBoundary: string;
  configFields: ConfigFieldSpec[];
};

export type InstalledIntegration = {
  pluginId: string;
  enabled: boolean;
  config: Record<string, string>;
  installedAt: string;
  updatedAt: string;
};

export const INTEGRATION_CATEGORIES: {
  id: IntegrationCategory | "all";
  label: string;
}[] = [
  { id: "all", label: "All" },
  { id: "notifications", label: "Notifications" },
  { id: "accounting", label: "Accounting" },
  { id: "treasury_automation", label: "Treasury Automation" },
];

const INSTALLS_KEY = "accord_integration_installs";

export const BUNDLED_INTEGRATIONS: IntegrationPlugin[] = [
  {
    id: "slack-notifications",
    name: "Slack Notifications",
    category: "notifications",
    summary: "Post proposal creation, quorum, and execution alerts to a Slack channel.",
    description:
      "Delivers structured webhook notifications when proposals are created, reach quorum, execute, or expire.",
    version: "1.0.0",
    publisher: "Accord Labs",
    reviewed: true,
    permissions: ["read:proposals", "read:events"],
    dataBoundary:
      "Sends proposal ID, category, token, amount, and status only; no private keys or signer PII.",
    configFields: [
      {
        key: "channelLabel",
        label: "Slack channel label",
        required: true,
        placeholder: "#treasury-alerts",
      },
    ],
  },
  {
    id: "discord-notifications",
    name: "Discord Notifications",
    category: "notifications",
    summary: "Stream multisig governance and recurring payroll alerts to Discord.",
    description:
      "Posts concise status embeds to a designated Discord governance channel for fast owner review.",
    version: "1.0.0",
    publisher: "Accord Labs",
    reviewed: true,
    permissions: ["read:proposals", "read:events"],
    dataBoundary:
      "Sends proposal ID, title, amount, and approval progress only; never accesses wallet secrets.",
    configFields: [
      {
        key: "channelLabel",
        label: "Discord channel name",
        required: true,
        placeholder: "#multisig-ops",
      },
    ],
  },
  {
    id: "quickbooks-accounting",
    name: "QuickBooks Accounting Sync",
    category: "accounting",
    summary: "Map executed treasury outflows to QuickBooks chart-of-accounts categories.",
    description:
      "Generates reconciled CSV/JSON journal batches from executed proposals and recurring disbursements.",
    version: "1.1.0",
    publisher: "Accord Labs",
    reviewed: true,
    permissions: ["read:proposals", "read:analytics", "export:reports"],
    dataBoundary:
      "Exports executed transaction hashes, timestamps, amounts, and categories; read-only, cannot initiate transfers.",
    configFields: [
      {
        key: "ledgerAccount",
        label: "Default expense account",
        required: true,
        placeholder: "Operating Expenses:Crypto Treasury",
      },
    ],
  },
  {
    id: "xero-accounting",
    name: "Xero Ledger Export",
    category: "accounting",
    summary: "Reconcile Stellar USDC and XLM treasury movements in Xero.",
    description:
      "Formats categorized outflows and recurring payroll disbursements into Xero-compatible statement batches.",
    version: "1.0.0",
    publisher: "Accord Labs",
    reviewed: true,
    permissions: ["read:proposals", "read:analytics", "export:reports"],
    dataBoundary:
      "Read-only export of executed transfers and categories; zero write or signing capability.",
    configFields: [
      {
        key: "ledgerAccount",
        label: "Xero account code",
        required: true,
        placeholder: "400 - Treasury Disbursements",
      },
    ],
  },
  {
    id: "recurring-keeper",
    name: "Recurring Payment Keeper",
    category: "treasury_automation",
    summary: "Automatically trigger due recurring payroll and grant disbursements.",
    description:
      "Monitors active recurring schedules and submits permissionless disburse_recurring calls when intervals elapse.",
    version: "1.0.0",
    publisher: "Accord Labs",
    reviewed: true,
    permissions: ["read:recurring", "trigger:disburse_recurring"],
    dataBoundary:
      "Calls permissionless disburse_recurring on already-approved schedules; cannot create or modify schedules.",
    configFields: [
      {
        key: "cadenceMinutes",
        label: "Check cadence (minutes)",
        required: true,
        placeholder: "15",
      },
    ],
  },
  {
    id: "idle-balance-sweep",
    name: "Idle Balance Sweep Advisor",
    category: "treasury_automation",
    summary: "Draft rebalance proposals when hot-wallet balances exceed policy thresholds.",
    description:
      "Watches contract token balances and drafts a Transfer proposal to cold storage when thresholds are exceeded. Always requires full multisig quorum.",
    version: "1.0.0",
    publisher: "Accord Labs",
    reviewed: true,
    permissions: ["read:balances", "draft:proposal"],
    dataBoundary:
      "Propose-only boundary: can draft a proposal for owner review, never approves or executes transfers.",
    configFields: [
      {
        key: "targetThreshold",
        label: "Sweep threshold (USDC)",
        required: true,
        placeholder: "50000",
      },
    ],
  },
];

function apiBaseUrl(): string {
  return (import.meta.env.VITE_ANALYTICS_API_URL as string | undefined)?.replace(/\/$/, "") ?? "";
}

export function getInstalledIntegrations(): Record<string, InstalledIntegration> {
  try {
    const raw = localStorage.getItem(INSTALLS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, InstalledIntegration>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveInstalledIntegrations(installs: Record<string, InstalledIntegration>): void {
  localStorage.setItem(INSTALLS_KEY, JSON.stringify(installs));
}

export function validateIntegrationConfig(
  plugin: IntegrationPlugin,
  config: Record<string, string>,
): string | null {
  for (const field of plugin.configFields) {
    const val = (config[field.key] ?? "").trim();
    if (field.required && !val) {
      return `${field.label} is required.`;
    }
    if (val.length > 512) {
      return `${field.label} must be 512 characters or fewer.`;
    }
  }
  return null;
}

export async function fetchIntegrationMarketplace(): Promise<{
  catalog: IntegrationPlugin[];
  installs: Record<string, InstalledIntegration>;
}> {
  const base = apiBaseUrl();
  if (!base) {
    return {
      catalog: BUNDLED_INTEGRATIONS,
      installs: getInstalledIntegrations(),
    };
  }

  const res = await fetch(`${base}/integrations`);
  if (!res.ok) {
    throw new Error(`Integration marketplace responded with ${res.status}`);
  }
  const data = (await res.json()) as {
    catalog: IntegrationPlugin[];
    installs: InstalledIntegration[];
  };
  const installsMap: Record<string, InstalledIntegration> = {};
  for (const item of data.installs ?? []) {
    installsMap[item.pluginId] = item;
  }
  return {
    catalog: data.catalog,
    installs: installsMap,
  };
}

export async function installIntegrationPlugin(
  plugin: IntegrationPlugin,
  config: Record<string, string>,
): Promise<InstalledIntegration> {
  const validationError = validateIntegrationConfig(plugin, config);
  if (validationError) {
    throw new Error(validationError);
  }

  const base = apiBaseUrl();
  if (base) {
    const res = await fetch(`${base}/integrations/${encodeURIComponent(plugin.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, config }),
    });
    if (!res.ok) {
      throw new Error(`Could not install ${plugin.name} (${res.status})`);
    }
    return (await res.json()) as InstalledIntegration;
  }

  const now = new Date().toISOString();
  const installs = getInstalledIntegrations();
  const entry: InstalledIntegration = {
    pluginId: plugin.id,
    enabled: true,
    config,
    installedAt: installs[plugin.id]?.installedAt ?? now,
    updatedAt: now,
  };
  installs[plugin.id] = entry;
  saveInstalledIntegrations(installs);
  return entry;
}

export async function uninstallIntegrationPlugin(pluginId: string): Promise<void> {
  const base = apiBaseUrl();
  if (base) {
    const res = await fetch(`${base}/integrations/${encodeURIComponent(pluginId)}`, {
      method: "DELETE",
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Could not uninstall integration (${res.status})`);
    }
    return;
  }

  const installs = getInstalledIntegrations();
  delete installs[pluginId];
  saveInstalledIntegrations(installs);
}
