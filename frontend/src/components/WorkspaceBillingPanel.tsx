import { useState } from "react";
import {
  DEFAULT_PLAN_CATALOG,
  isNearQuota,
  isValidBillingEmail,
  nextUpgradeTier,
  updateBillingPlan,
  usagePercent,
  type PlanTier,
  type WorkspacePlan,
} from "../lib/billing";

type WorkspaceBillingPanelProps = {
  contractId: string;
  network?: string;
  canManageBilling: boolean;
  initialPlan?: WorkspacePlan;
};

function defaultPlan(contractId: string, network: string): WorkspacePlan {
  const free = DEFAULT_PLAN_CATALOG[0].limits;
  return {
    network,
    contractId,
    planTier: "free",
    workspacesLimit: free.workspacesLimit,
    apiRequestsUsed: 0,
    apiRequestsLimit: free.apiRequestsLimit,
    reportsUsed: 0,
    reportsLimit: free.reportsLimit,
    integrationsUsed: 0,
    integrationsLimit: free.integrationsLimit,
    billingEmail: null,
    status: "active",
  };
}

export function WorkspaceBillingPanel({
  contractId,
  network = "testnet",
  canManageBilling,
  initialPlan,
}: WorkspaceBillingPanelProps) {
  const [plan, setPlan] = useState<WorkspacePlan>(
    () => initialPlan ?? defaultPlan(contractId, network),
  );
  const [billingEmail, setBillingEmail] = useState(initialPlan?.billingEmail ?? "");
  const [updating, setUpdating] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const recommendedUpgrade = nextUpgradeTier(plan.planTier);
  const meters = [
    {
      label: "API requests",
      used: plan.apiRequestsUsed,
      limit: plan.apiRequestsLimit,
    },
    {
      label: "Reports",
      used: plan.reportsUsed,
      limit: plan.reportsLimit,
    },
    {
      label: "Integrations",
      used: plan.integrationsUsed,
      limit: plan.integrationsLimit,
    },
  ];

  async function handleSelectTier(tier: PlanTier) {
    setStatusMessage(null);
    setErrorMessage(null);

    if (!canManageBilling) {
      setErrorMessage("Only workspace owners can change billing plans.");
      return;
    }
    if (!isValidBillingEmail(billingEmail)) {
      setErrorMessage("Enter a valid billing email address before updating the plan.");
      return;
    }

    setUpdating(true);
    try {
      const updated = await updateBillingPlan(contractId, network, tier, billingEmail);
      setPlan(updated.plan);
      setStatusMessage(`Workspace plan updated to ${updated.plan.planTier.toUpperCase()}.`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to update billing plan.");
    } finally {
      setUpdating(false);
    }
  }

  return (
    <section
      aria-labelledby="workspace-billing-heading"
      className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="workspace-billing-heading" className="text-base font-semibold text-zinc-100">
            Workspace billing &amp; usage plans
          </h2>
          <p className="mt-1 text-xs text-zinc-400">
            Current tier:{" "}
            <span className="font-semibold uppercase text-zinc-100">{plan.planTier}</span> (
            {plan.workspacesLimit} workspace{plan.workspacesLimit === 1 ? "" : "s"} max)
          </p>
        </div>
        {recommendedUpgrade && (
          <button
            type="button"
            disabled={!canManageBilling || updating}
            onClick={() => handleSelectTier(recommendedUpgrade)}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            Upgrade to {recommendedUpgrade.toUpperCase()}
          </button>
        )}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {meters.map((m) => {
          const pct = usagePercent(m.used, m.limit);
          const near = isNearQuota(m.used, m.limit);
          return (
            <div key={m.label} className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3">
              <div className="flex items-center justify-between text-xs">
                <span className="text-zinc-400">{m.label}</span>
                <span className={near ? "font-medium text-amber-400" : "text-zinc-200"}>
                  {m.used.toLocaleString()} / {m.limit.toLocaleString()}
                </span>
              </div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                <div
                  className={near ? "h-full bg-amber-500" : "h-full bg-blue-500"}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-4">
        <label htmlFor="billing-email" className="block text-xs font-medium text-zinc-300">
          Billing email
        </label>
        <input
          id="billing-email"
          type="email"
          value={billingEmail}
          disabled={!canManageBilling || updating}
          onChange={(e) => setBillingEmail(e.target.value)}
          placeholder="billing@acme.org"
          className="mt-1 w-full max-w-sm rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
        />
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {DEFAULT_PLAN_CATALOG.map((entry) => {
          const isCurrent = entry.tier === plan.planTier;
          return (
            <div
              key={entry.tier}
              className={`rounded-lg border p-3 ${
                isCurrent ? "border-blue-500 bg-blue-950/20" : "border-zinc-800 bg-zinc-950/40"
              }`}
            >
              <div className="flex items-baseline justify-between">
                <span className="text-sm font-semibold uppercase text-zinc-100">{entry.tier}</span>
                <span className="text-xs text-zinc-400">${entry.limits.monthlyPriceUsd}/mo</span>
              </div>
              <ul className="mt-2 space-y-1 text-xs text-zinc-400">
                <li>{entry.limits.workspacesLimit} workspaces</li>
                <li>{entry.limits.apiRequestsLimit.toLocaleString()} API reqs/mo</li>
                <li>{entry.limits.reportsLimit} reports/mo</li>
                <li>{entry.limits.integrationsLimit} integrations</li>
              </ul>
              <button
                type="button"
                disabled={isCurrent || !canManageBilling || updating}
                onClick={() => handleSelectTier(entry.tier)}
                className="mt-3 w-full rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
              >
                {isCurrent ? "Current plan" : `Select ${entry.tier}`}
              </button>
            </div>
          );
        })}
      </div>

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
