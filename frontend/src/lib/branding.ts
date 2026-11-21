export type DomainStatus = "pending" | "verified" | "failed";

export type WorkspaceBranding = {
  network: string;
  contractId: string;
  brandName: string | null;
  logoUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
  customDomain: string | null;
  domainStatus: DomainStatus;
  verificationToken: string | null;
};

export type BrandingDraft = {
  brandName: string;
  logoUrl: string;
  primaryColor: string;
  accentColor: string;
  customDomain: string;
};

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const HOSTNAME_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isValidHexColor(value: string): boolean {
  return HEX_COLOR_RE.test(value.trim());
}

export function isValidLogoUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (!trimmed.startsWith("https://") || /\s/.test(trimmed)) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:" && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

export function isValidCustomDomain(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return true;
  return HOSTNAME_RE.test(trimmed);
}

export function validateBrandingDraft(draft: BrandingDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (draft.brandName.trim().length > 80) {
    errors.brandName = "Brand name must be at most 80 characters.";
  }
  if (draft.logoUrl.trim() && !isValidLogoUrl(draft.logoUrl)) {
    errors.logoUrl = "Logo URL must be a valid https:// URL without spaces.";
  }
  if (draft.primaryColor.trim() && !isValidHexColor(draft.primaryColor)) {
    errors.primaryColor = "Primary color must be a 6-digit hex value (e.g. #2563eb).";
  }
  if (draft.accentColor.trim() && !isValidHexColor(draft.accentColor)) {
    errors.accentColor = "Accent color must be a 6-digit hex value (e.g. #0ea5e9).";
  }
  if (draft.customDomain.trim() && !isValidCustomDomain(draft.customDomain)) {
    errors.customDomain = "Enter a valid hostname such as treasury.acme.org.";
  }
  return errors;
}

export function buildDnsVerificationRecord(domain: string, token: string): {
  recordType: "TXT";
  host: string;
  value: string;
} {
  return {
    recordType: "TXT",
    host: `_accord-verification.${domain.trim().toLowerCase()}`,
    value: token,
  };
}

export function applyWorkspaceBranding(
  branding: Pick<WorkspaceBranding, "primaryColor" | "accentColor">,
  target: HTMLElement | null = typeof document !== "undefined" ? document.documentElement : null,
): void {
  if (!target) return;
  if (branding.primaryColor && isValidHexColor(branding.primaryColor)) {
    target.style.setProperty("--accord-brand-primary", branding.primaryColor.toLowerCase());
  } else {
    target.style.removeProperty("--accord-brand-primary");
  }
  if (branding.accentColor && isValidHexColor(branding.accentColor)) {
    target.style.setProperty("--accord-brand-accent", branding.accentColor.toLowerCase());
  } else {
    target.style.removeProperty("--accord-brand-accent");
  }
}

function apiBaseUrl(): string {
  return (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/+$/, "") ?? "";
}

export async function fetchWorkspaceBranding(
  contractId: string,
  network = "testnet",
): Promise<WorkspaceBranding | null> {
  const base = apiBaseUrl();
  if (!base) return null;
  const params = new URLSearchParams({ contractId, network, limit: "1" });
  const res = await fetch(`${base}/branding?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`Failed to load workspace branding (${res.status})`);
  }
  const data = (await res.json()) as { items?: WorkspaceBranding[] };
  return data.items?.[0] ?? null;
}

export async function saveWorkspaceBranding(
  contractId: string,
  network: string,
  draft: BrandingDraft,
  adminToken?: string,
): Promise<WorkspaceBranding> {
  const base = apiBaseUrl();
  if (!base) {
    throw new Error("Analytics API base URL is not configured.");
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (adminToken) {
    headers.Authorization = `Bearer ${adminToken}`;
  }
  const params = new URLSearchParams({ contractId, network });
  const res = await fetch(`${base}/branding?${params.toString()}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      brandName: draft.brandName.trim() || null,
      logoUrl: draft.logoUrl.trim() || null,
      primaryColor: draft.primaryColor.trim().toLowerCase() || null,
      accentColor: draft.accentColor.trim().toLowerCase() || null,
      customDomain: draft.customDomain.trim().toLowerCase() || null,
    }),
  });
  if (!res.ok) {
    const errBody = (await res.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    throw new Error(errBody?.error?.message ?? `Failed to save branding (${res.status})`);
  }
  return (await res.json()) as WorkspaceBranding;
}

export async function resetWorkspaceBranding(
  contractId: string,
  network: string,
  adminToken?: string,
): Promise<void> {
  const base = apiBaseUrl();
  if (!base) {
    throw new Error("Analytics API base URL is not configured.");
  }
  const headers: Record<string, string> = {};
  if (adminToken) {
    headers.Authorization = `Bearer ${adminToken}`;
  }
  const params = new URLSearchParams({ contractId, network });
  const res = await fetch(`${base}/branding?${params.toString()}`, {
    method: "DELETE",
    headers,
  });
  if (!res.ok) {
    throw new Error(`Failed to reset branding (${res.status})`);
  }
}
