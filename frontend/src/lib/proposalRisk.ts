import type { Proposal } from "../types/accord";

export type RiskLevel = "low" | "medium" | "high";

export type RiskSignal = {
  id: "new_recipient" | "large_amount" | "concentrated_weight" | "short_deadline";
  label: string;
  detail: string;
  points: number;
};

export type ProposalRisk = {
  score: number;
  level: RiskLevel;
  signals: RiskSignal[];
};

const HOUR_MS = 60 * 60 * 1000;

function toNumber(value: string | undefined): number {
  const n = Number.parseFloat((value ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Heuristic risk score (0-100) from recipient, amount, weight and timing signals,
 * compared against the other proposals in the vault.
 */
export function scoreProposalRisk(
  proposal: Proposal,
  history: Proposal[],
  now: number = Date.now(),
): ProposalRisk {
  const others = history.filter((p) => p.id !== proposal.id);
  const signals: RiskSignal[] = [];

  if (proposal.kind === "transfer" || proposal.kind === "recurring") {
    const seen = others.some((p) => p.to === proposal.to);
    if (!seen && others.length > 0) {
      signals.push({
        id: "new_recipient",
        label: "New recipient",
        detail: "This address has not received funds from earlier proposals.",
        points: 30,
      });
    }
  }

  const sameToken = others.filter((p) => p.token === proposal.token).map((p) => toNumber(p.amount));
  const typical = median(sameToken);
  const amount = toNumber(proposal.amount);
  if (typical > 0 && amount >= typical * 3) {
    signals.push({
      id: "large_amount",
      label: "Unusually large amount",
      detail: `About ${Math.round(amount / typical)}x the typical ${proposal.token} proposal.`,
      points: 30,
    });
  }

  const weights = Object.values(proposal.approverWeights ?? {});
  const total = proposal.totalWeight ?? 0;
  if (total > 0 && weights.some((w) => w / total > 0.5)) {
    signals.push({
      id: "concentrated_weight",
      label: "Concentrated approval weight",
      detail: "A single approver holds more than half of the total voting weight.",
      points: 20,
    });
  }

  // deadlineTs comes from the contract in seconds.
  const remaining = proposal.deadlineTs * 1000 - now;
  if (proposal.status === "pending" && remaining > 0 && remaining < 24 * HOUR_MS) {
    signals.push({
      id: "short_deadline",
      label: "Short review window",
      detail: "Less than 24 hours remain before the deadline.",
      points: 20,
    });
  }

  const score = Math.min(100, signals.reduce((sum, s) => sum + s.points, 0));
  const level: RiskLevel = score >= 50 ? "high" : score >= 25 ? "medium" : "low";
  return { score, level, signals };
}
