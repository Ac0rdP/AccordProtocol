import { describe, expect, it } from "vitest";
import type { Proposal } from "../types/accord";
import { scoreProposalRisk } from "./proposalRisk";

const NOW = Date.UTC(2026, 5, 1);
const make = (overrides: Partial<Proposal>): Proposal => ({
  id: 1,
  kind: "transfer",
  to: "GKNOWN",
  amount: "100",
  token: "XLM",
  description: "",
  approvals: 0,
  threshold: 2,
  status: "pending",
  deadline: "",
  deadlineTs: NOW / 1000 + 7 * 86_400,
  createdAt: "",
  proposer: "GP",
  userHasApproved: false,
  approverAddresses: [],
  ...overrides,
});

const history = [make({ id: 2 }), make({ id: 3 }), make({ id: 4 })];

describe("scoreProposalRisk", () => {
  it("is low risk for a familiar recipient and typical amount", () => {
    const risk = scoreProposalRisk(make({ id: 10 }), history, NOW);
    expect(risk).toMatchObject({ score: 0, level: "low", signals: [] });
  });

  it("flags new recipient, large amount, concentrated weight and short deadline", () => {
    const risk = scoreProposalRisk(
      make({
        id: 10,
        to: "GNEW",
        amount: "1000",
        totalWeight: 10,
        approverWeights: { GA: 6 },
        deadlineTs: NOW / 1000 + 3600,
      }),
      history,
      NOW,
    );
    expect(risk.signals.map((s) => s.id)).toEqual([
      "new_recipient",
      "large_amount",
      "concentrated_weight",
      "short_deadline",
    ]);
    expect(risk.score).toBe(100);
    expect(risk.level).toBe("high");
  });
});
