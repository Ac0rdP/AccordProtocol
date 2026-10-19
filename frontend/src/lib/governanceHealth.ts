export type GovernanceRating = "Healthy" | "Moderate Risk" | "High Risk" | "Critical Risk";

export interface GovernanceHealthAnalysis {
  /** Numerical score from 0 to 100 */
  score: number;
  /** High-level rating */
  rating: GovernanceRating;
  /** Summary sentence in plain language */
  explanation: string;
  /** Specific flagged risk messages */
  flaggedRisks: string[];
  /** Share of total voting power held by the single largest owner (0-100) */
  dominantSharePct: number;
  /** Dominant owner's address */
  dominantAddress: string | null;
  /** Ratio of quorum threshold to total weight (0-100) */
  quorumRatioPct: number;
}

export interface GovernanceHealthInput {
  weights: Record<string, number>;
  totalWeight: number;
  threshold?: number;
  totalOwners?: number;
  warningThresholdPct?: number;
}

/**
 * Computes a governance-health score (0-100) and plain-language explanation
 * based on single-owner concentration, quorum feasibility, and signer redundancy.
 */
export function calculateGovernanceHealth({
  weights,
  totalWeight,
  threshold,
  totalOwners: providedTotalOwners,
  warningThresholdPct = 33.33,
}: GovernanceHealthInput): GovernanceHealthAnalysis {
  const entries = Object.entries(weights);
  const totalOwners = providedTotalOwners ?? entries.length;

  if (totalOwners === 0 || totalWeight <= 0) {
    return {
      score: 0,
      rating: "Critical Risk",
      explanation: "No active multisig owners or weights configured.",
      flaggedRisks: ["Multisig has no owners or total voting weight is zero."],
      dominantSharePct: 0,
      dominantAddress: null,
      quorumRatioPct: 0,
    };
  }

  // Find dominant owner
  const dominantEntry = entries.reduce(
    (best, cur) => (cur[1] > best[1] ? cur : best),
    entries[0] ?? ["", 0],
  );
  const dominantAddress = dominantEntry?.[0] || null;
  const dominantWeight = dominantEntry?.[1] || 0;
  const dominantSharePct = totalWeight > 0 ? (dominantWeight / totalWeight) * 100 : 0;

  const quorum = threshold ?? Math.ceil(totalWeight * 0.5);
  const quorumRatioPct = totalWeight > 0 ? (quorum / totalWeight) * 100 : 0;

  const flaggedRisks: string[] = [];

  // Concentration scoring (max 40 pts)
  let concentrationPts = 40;
  if (dominantSharePct > 50) {
    concentrationPts = 5;
    flaggedRisks.push(
      `Dominant owner controls ${dominantSharePct.toFixed(1)}% of voting power (>50%), holding absolute majority control.`,
    );
  } else if (dominantSharePct > warningThresholdPct) {
    concentrationPts = 20;
    flaggedRisks.push(
      `Largest owner holds ${dominantSharePct.toFixed(1)}% of voting power, exceeding the recommended ${warningThresholdPct.toFixed(0)}% safety threshold.`,
    );
  } else if (dominantSharePct > 25) {
    concentrationPts = 32;
  }

  // Quorum safety scoring (max 40 pts)
  let quorumPts = 40;
  if (quorum > totalWeight) {
    quorumPts = 0;
    flaggedRisks.push(
      `Quorum threshold (${quorum}) exceeds total voting weight (${totalWeight}), making proposals impossible to pass.`,
    );
  } else if (quorum <= 0) {
    quorumPts = 5;
    flaggedRisks.push("Quorum threshold is 0, allowing unauthorized execution.");
  } else if (quorumRatioPct > 80) {
    quorumPts = 18;
    flaggedRisks.push(
      `High quorum requirement (${quorumRatioPct.toFixed(0)}% of total weight) risks governance gridlock if key signers become unavailable.`,
    );
  } else if (quorumRatioPct < 40) {
    quorumPts = 22;
    flaggedRisks.push(
      `Low quorum requirement (${quorumRatioPct.toFixed(0)}% of total weight) may allow low-consensus execution.`,
    );
  } else {
    quorumPts = 40;
  }

  // Check if single dominant owner can unilaterally satisfy quorum
  if (dominantWeight >= quorum && totalOwners > 1) {
    concentrationPts = Math.min(concentrationPts, 10);
    flaggedRisks.push("A single owner holds enough voting power to pass proposals unilaterally.");
  }

  // Signer redundancy & decentralization scoring (max 20 pts)
  let redundancyPts = 20;
  if (totalOwners <= 1) {
    redundancyPts = 0;
    flaggedRisks.push("Only 1 owner configured; no multisig redundancy.");
  } else if (totalOwners === 2) {
    redundancyPts = 10;
    if (quorum === 2) {
      flaggedRisks.push("2-of-2 multisig requires unanimous sign-off with no fault tolerance.");
    }
  } else if (totalOwners >= 3 && totalOwners < 5) {
    redundancyPts = 16;
  } else {
    redundancyPts = 20;
  }

  const rawScore = concentrationPts + quorumPts + redundancyPts;
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));

  let rating: GovernanceRating = "Healthy";
  if (score < 40) {
    rating = "Critical Risk";
  } else if (score < 65) {
    rating = "High Risk";
  } else if (score < 80) {
    rating = "Moderate Risk";
  } else {
    rating = "Healthy";
  }

  // Plain-language explanation
  let explanation = "";
  if (rating === "Healthy") {
    explanation = "Governance is well-balanced with distributed voting power and an achievable quorum.";
  } else if (rating === "Moderate Risk") {
    explanation = "Governance has moderate concentration or quorum friction. Minor rebalancing is recommended.";
  } else if (rating === "High Risk") {
    explanation = "Governance faces significant centralization or liveness risks that could compromise security.";
  } else {
    explanation = "Critical governance vulnerabilities detected: proposals may be blocked or controlled unilaterally.";
  }

  return {
    score,
    rating,
    explanation,
    flaggedRisks,
    dominantSharePct: parseFloat(dominantSharePct.toFixed(1)),
    dominantAddress,
    quorumRatioPct: parseFloat(quorumRatioPct.toFixed(1)),
  };
}
