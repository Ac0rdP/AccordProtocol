import { WhaleWarningBadge } from "./WhaleWarningBadge";
import { weightToPercent, formatWeightPercent, shortenAddr } from "../lib/soroban";
import { calculateGovernanceHealth } from "../lib/governanceHealth";

export interface GovernanceHealthWidgetProps {
  /**
   * Map of owner address → weight, sourced from useOwnerWeights.
   */
  weights: Record<string, number>;
  /**
   * Sum of all owner weights. When 0 the widget shows a loading/empty state.
   */
  totalWeight: number;
  /**
   * Current required quorum threshold.
   */
  threshold?: number;
  /**
   * Total number of owners (if known).
   */
  totalOwners?: number;
  /**
   * Whether the underlying hook is still fetching data.
   */
  loading?: boolean;
  /**
   * Concentration threshold (%). A warning is shown when the largest single
   * owner holds more than this share of total voting power.
   * Defaults to 33.33 (one-third).
   */
  warningThresholdPct?: number;
}

/**
 * Governance Health widget — shows the overall governance-health score,
 * plain-language explanation, largest owner's share of total voting
 * power, and flagged centralization / quorum risks.
 */
export function GovernanceHealthWidget({
  weights,
  totalWeight,
  threshold,
  totalOwners,
  loading = false,
  warningThresholdPct = 100 / 3, // one-third ≈ 33.33 %
}: GovernanceHealthWidgetProps) {
  // Derive the dominant owner from the weight map.
  const entries = Object.entries(weights);
  const dominantEntry =
    entries.length > 0
      ? entries.reduce((best, cur) => (cur[1] > best[1] ? cur : best), entries[0])
      : null;

  const dominantAddress = dominantEntry?.[0] ?? null;
  const dominantWeight = dominantEntry?.[1] ?? 0;
  const dominantPct =
    dominantAddress !== null ? weightToPercent(dominantWeight, totalWeight) : 0;

  const isConcentrated = dominantPct > warningThresholdPct;

  const analysis = calculateGovernanceHealth({
    weights,
    totalWeight,
    threshold,
    totalOwners: totalOwners ?? entries.length,
    warningThresholdPct,
  });

  // Bar fill colour: green → amber → red as concentration rises.
  const barColour =
    dominantPct > 50
      ? "bg-red-500"
      : dominantPct > warningThresholdPct
      ? "bg-amber-400"
      : "bg-emerald-400";

  const ratingBadgeStyles = {
    Healthy: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    "Moderate Risk": "bg-amber-500/15 text-amber-400 border-amber-500/30",
    "High Risk": "bg-orange-500/15 text-orange-400 border-orange-500/30",
    "Critical Risk": "bg-red-500/15 text-red-400 border-red-500/30",
  }[analysis.rating];

  return (
    <div
      role="region"
      className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 mb-6"
      aria-label="Governance Health"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2.5">
          <h3 className="font-semibold text-sm">Governance Health</h3>
          {!loading && totalWeight > 0 && (
            <span
              data-testid="governance-health-score"
              className={`text-xs px-2 py-0.5 rounded-full border font-medium ${ratingBadgeStyles}`}
            >
              Score: {analysis.score}/100 · {analysis.rating}
            </span>
          )}
        </div>

        {loading ? (
          <span className="text-xs text-zinc-600 dark:text-zinc-400 animate-pulse">Loading…</span>
        ) : (
          <WhaleWarningBadge
            triggered={isConcentrated}
            sharePct={parseFloat(dominantPct.toFixed(1))}
            thresholdPct={parseFloat(warningThresholdPct.toFixed(1))}
          />
        )}
      </div>

      {loading || totalWeight === 0 ? (
        <div className="space-y-2">
          {/* Skeleton bar */}
          <div className="h-3 rounded-full bg-zinc-800 border border-zinc-700 animate-pulse" />
          <p className="text-xs text-zinc-600 dark:text-zinc-400">Fetching owner weights…</p>
        </div>
      ) : (
        <>
          {/* Plain language explanation */}
          <p
            data-testid="governance-explanation"
            className="text-xs text-zinc-300 mb-3 leading-relaxed"
          >
            {analysis.explanation}
          </p>

          {/* Progress bar showing dominant owner's share */}
          <div className="mb-3">
            <div
              className="relative h-3 rounded-full bg-zinc-800 border border-zinc-700 overflow-hidden"
              role="img"
              aria-label={`Largest owner holds ${formatWeightPercent(dominantWeight, totalWeight)} of total voting power`}
            >
              <div
                className={`absolute left-0 top-0 bottom-0 transition-all duration-500 ${barColour}`}
                style={{ width: `${Math.min(dominantPct, 100)}%` }}
              />
              {/* Warning threshold tick */}
              <div
                aria-hidden
                className="absolute top-0 bottom-0 w-px bg-amber-400/70"
                style={{ left: `${Math.min(warningThresholdPct, 100)}%` }}
                title={`Warning threshold: ${warningThresholdPct.toFixed(1)}%`}
              />
            </div>
          </div>

          {/* Stats row */}
          <div className="flex items-start justify-between gap-4 text-xs">
            <div>
              <p className="text-zinc-600 dark:text-zinc-400 mb-0.5">Largest single owner</p>
              {dominantAddress ? (
                <p className="font-mono text-zinc-300">
                  {shortenAddr(dominantAddress)}
                </p>
              ) : (
                <p className="text-zinc-600 dark:text-zinc-400">No owners found</p>
              )}
            </div>

            <div className="text-right">
              <p className="text-zinc-600 dark:text-zinc-400 mb-0.5">Share of voting power</p>
              <p
                className={`font-semibold text-sm tabular-nums ${
                  isConcentrated ? "text-amber-400" : "text-emerald-400"
                }`}
              >
                {formatWeightPercent(dominantWeight, totalWeight)}
              </p>
              <p className="text-zinc-600 dark:text-zinc-400">
                {dominantWeight} / {totalWeight} weight
              </p>
            </div>

            <div className="text-right">
              <p className="text-zinc-600 dark:text-zinc-400 mb-0.5">Owners</p>
              <p className="text-zinc-300">{entries.length}</p>
            </div>
          </div>

          {/* Flagged Risks section */}
          {analysis.flaggedRisks.length > 0 && (
            <div
              data-testid="governance-risks"
              className="mt-3 pt-3 border-t border-zinc-800/80 space-y-1.5"
            >
              <p className="text-xs font-medium text-amber-400">Flagged Risks:</p>
              <ul className="text-xs space-y-1 text-zinc-400 list-disc list-inside">
                {analysis.flaggedRisks.map((risk, idx) => (
                  <li key={idx} className="leading-relaxed">
                    {risk}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Inline warning detail when concentrated and not already detailed */}
          {isConcentrated && analysis.flaggedRisks.length === 0 && (
            <p className="mt-3 text-xs text-amber-300/80 leading-relaxed border-t border-amber-500/20 pt-2">
              One owner controls more than{" "}
              <span className="font-semibold">
                {warningThresholdPct.toFixed(0)}%
              </span>{" "}
              of total voting power. Consider redistributing weight to reduce
              centralization risk.
            </p>
          )}
        </>
      )}
    </div>
  );
}
