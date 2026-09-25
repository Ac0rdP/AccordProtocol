export type ImpactLevel = "low" | "medium" | "high" | "critical";

export interface GovernanceImpactBadgeProps {
  impact?: ImpactLevel;
  label?: string;
  className?: string;
}

const IMPACT_STYLES: Record<ImpactLevel, string> = {
  low: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  medium: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  high: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  critical: "bg-red-500/10 text-red-400 border-red-500/20",
};

export function GovernanceImpactBadge({
  impact = "medium",
  label,
  className = "",
}: GovernanceImpactBadgeProps) {
  const badgeStyle = IMPACT_STYLES[impact] || IMPACT_STYLES.medium;
  const displayLabel = label || `Governance Impact: ${impact}`;

  return (
    <span
      role="status"
      aria-label={displayLabel}
      className={`inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-medium uppercase tracking-wider ${badgeStyle} ${className}`.trim()}
    >
      {displayLabel}
    </span>
  );
}
