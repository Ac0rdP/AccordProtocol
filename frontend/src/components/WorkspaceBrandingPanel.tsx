import { useState } from "react";
import {
  applyWorkspaceBranding,
  buildDnsVerificationRecord,
  resetWorkspaceBranding,
  saveWorkspaceBranding,
  validateBrandingDraft,
  type BrandingDraft,
  type WorkspaceBranding,
} from "../lib/branding";

type WorkspaceBrandingPanelProps = {
  contractId: string;
  network?: string;
  canEdit: boolean;
  initialBranding?: WorkspaceBranding | null;
};

const EMPTY_DRAFT: BrandingDraft = {
  brandName: "",
  logoUrl: "",
  primaryColor: "#2563eb",
  accentColor: "#0ea5e9",
  customDomain: "",
};

export function WorkspaceBrandingPanel({
  contractId,
  network = "testnet",
  canEdit,
  initialBranding = null,
}: WorkspaceBrandingPanelProps) {
  const [draft, setDraft] = useState<BrandingDraft>(() =>
    initialBranding
      ? {
          brandName: initialBranding.brandName ?? "",
          logoUrl: initialBranding.logoUrl ?? "",
          primaryColor: initialBranding.primaryColor ?? "#2563eb",
          accentColor: initialBranding.accentColor ?? "#0ea5e9",
          customDomain: initialBranding.customDomain ?? "",
        }
      : EMPTY_DRAFT,
  );
  const [saved, setSaved] = useState<WorkspaceBranding | null>(initialBranding);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatusMessage(null);
    setErrorMessage(null);

    if (!canEdit) {
      setErrorMessage("Only workspace owners can update white-label branding.");
      return;
    }

    const errors = validateBrandingDraft(draft);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      return;
    }

    setSaving(true);
    try {
      const updated = await saveWorkspaceBranding(contractId, network, draft);
      setSaved(updated);
      applyWorkspaceBranding(updated);
      setStatusMessage("White-label branding saved.");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to save branding.");
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    setStatusMessage(null);
    setErrorMessage(null);
    if (!canEdit) {
      setErrorMessage("Only workspace owners can reset white-label branding.");
      return;
    }

    setSaving(true);
    try {
      await resetWorkspaceBranding(contractId, network);
      setDraft(EMPTY_DRAFT);
      setSaved(null);
      applyWorkspaceBranding({ primaryColor: null, accentColor: null });
      setStatusMessage("Reset to default Accord branding.");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to reset branding.");
    } finally {
      setSaving(false);
    }
  }

  const dnsRecord =
    saved?.customDomain && saved.verificationToken
      ? buildDnsVerificationRecord(saved.customDomain, saved.verificationToken)
      : null;

  return (
    <section
      aria-labelledby="workspace-branding-heading"
      className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="workspace-branding-heading" className="text-base font-semibold text-zinc-100">
            White-label branding &amp; custom domain
          </h2>
          <p className="mt-1 text-xs text-zinc-400">
            Customize workspace name, logo, palette, and custom domain on shared contract
            infrastructure.
          </p>
        </div>
        {!canEdit && (
          <span className="rounded-full border border-zinc-700 px-2.5 py-0.5 text-xs text-zinc-400">
            Owner access required
          </span>
        )}
      </div>

      <form onSubmit={handleSubmit} className="mt-4 grid gap-4 sm:grid-cols-2" noValidate>
        <div>
          <label htmlFor="branding-name" className="block text-xs font-medium text-zinc-300">
            Brand name
          </label>
          <input
            id="branding-name"
            type="text"
            value={draft.brandName}
            disabled={!canEdit || saving}
            onChange={(e) => setDraft((d) => ({ ...d, brandName: e.target.value }))}
            placeholder="Acme Treasury"
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
          />
          {fieldErrors.brandName && (
            <p className="mt-1 text-xs text-red-400">{fieldErrors.brandName}</p>
          )}
        </div>

        <div>
          <label htmlFor="branding-logo" className="block text-xs font-medium text-zinc-300">
            Logo URL (HTTPS)
          </label>
          <input
            id="branding-logo"
            type="url"
            value={draft.logoUrl}
            disabled={!canEdit || saving}
            onChange={(e) => setDraft((d) => ({ ...d, logoUrl: e.target.value }))}
            placeholder="https://cdn.example.org/logo.svg"
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
          />
          {fieldErrors.logoUrl && (
            <p className="mt-1 text-xs text-red-400">{fieldErrors.logoUrl}</p>
          )}
        </div>

        <div>
          <label htmlFor="branding-primary" className="block text-xs font-medium text-zinc-300">
            Primary color
          </label>
          <input
            id="branding-primary"
            type="text"
            value={draft.primaryColor}
            disabled={!canEdit || saving}
            onChange={(e) => setDraft((d) => ({ ...d, primaryColor: e.target.value }))}
            placeholder="#2563eb"
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100"
          />
          {fieldErrors.primaryColor && (
            <p className="mt-1 text-xs text-red-400">{fieldErrors.primaryColor}</p>
          )}
        </div>

        <div>
          <label htmlFor="branding-accent" className="block text-xs font-medium text-zinc-300">
            Accent color
          </label>
          <input
            id="branding-accent"
            type="text"
            value={draft.accentColor}
            disabled={!canEdit || saving}
            onChange={(e) => setDraft((d) => ({ ...d, accentColor: e.target.value }))}
            placeholder="#0ea5e9"
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100"
          />
          {fieldErrors.accentColor && (
            <p className="mt-1 text-xs text-red-400">{fieldErrors.accentColor}</p>
          )}
        </div>

        <div className="sm:col-span-2">
          <label htmlFor="branding-domain" className="block text-xs font-medium text-zinc-300">
            Custom domain
          </label>
          <input
            id="branding-domain"
            type="text"
            value={draft.customDomain}
            disabled={!canEdit || saving}
            onChange={(e) => setDraft((d) => ({ ...d, customDomain: e.target.value }))}
            placeholder="treasury.acme.org"
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
          />
          {fieldErrors.customDomain && (
            <p className="mt-1 text-xs text-red-400">{fieldErrors.customDomain}</p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <button
            type="submit"
            disabled={!canEdit || saving}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save branding"}
          </button>
          <button
            type="button"
            disabled={!canEdit || saving}
            onClick={handleReset}
            className="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          >
            Reset to defaults
          </button>
        </div>
      </form>

      {dnsRecord && (
        <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950/70 p-3 text-xs text-zinc-300">
          <p className="font-medium text-zinc-200">
            DNS Verification ({saved?.domainStatus ?? "pending"})
          </p>
          <p className="mt-1">
            Add a <span className="font-mono">{dnsRecord.recordType}</span> record for{" "}
            <span className="font-mono text-zinc-100">{dnsRecord.host}</span> with value{" "}
            <span className="font-mono text-zinc-100">{dnsRecord.value}</span>.
          </p>
        </div>
      )}

      {statusMessage && (
        <p role="status" className="mt-3 text-xs text-emerald-400">
          {statusMessage}
        </p>
      )}
      {errorMessage && (
        <p role="alert" className="mt-3 text-xs text-red-400">
          {errorMessage}
        </p>
      )}
    </section>
  );
}
