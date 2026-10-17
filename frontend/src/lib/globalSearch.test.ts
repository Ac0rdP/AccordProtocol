import { describe, expect, test } from "vitest";
import type { Owner, Proposal, RecurringSchedule } from "../types/accord";
import {
  buildRecipientIndex,
  groupSearchResults,
  searchGlobal,
} from "./globalSearch";

const proposals: Proposal[] = [
  {
    id: 12,
    kind: "transfer",
    to: "GRECIPIENTAAA111",
    amount: "100",
    token: "USDC",
    description: "Payroll for March",
    approvals: 1,
    threshold: 2,
    status: "pending",
    deadline: "soon",
    deadlineTs: 1,
    createdAt: "now",
    proposer: "GPROPOSERAAA000",
    userHasApproved: false,
    approverAddresses: [],
  },
  {
    id: 99,
    kind: "add_owner",
    to: "GNEWOWNERBBB222",
    amount: "0",
    token: "XLM",
    description: "Onboard Alice",
    approvals: 2,
    threshold: 2,
    status: "ready",
    deadline: "soon",
    deadlineTs: 1,
    createdAt: "now",
    proposer: "GPROPOSERAAA000",
    userHasApproved: true,
    approverAddresses: [],
  },
];

const owners: Owner[] = [
  { address: "GOWNERALICE0001", label: "Alice" },
  { address: "GOWNERBOB000002", label: "Bob" },
];

const schedules: RecurringSchedule[] = [
  {
    id: 5,
    recipient: "GVESTINGCCC333",
    amount: "10",
    totalDisbursed: "0",
    status: "active",
  },
];

describe("globalSearch", () => {
  test("matches proposals by description, id, and address", () => {
    const index = {
      proposals,
      owners,
      recipients: buildRecipientIndex(proposals, schedules),
    };

    const byDescription = searchGlobal("payroll", index);
    expect(byDescription.some((r) => r.id === "proposal-12")).toBe(true);
    expect(byDescription[0].matchedOn).toContain("description");

    const byId = searchGlobal("99", index);
    expect(byId.some((r) => r.id === "proposal-99")).toBe(true);
    expect(byId.find((r) => r.id === "proposal-99")?.to).toBe(
      "/app/proposals/99",
    );

    const byAddress = searchGlobal("GRECIPIENTAAA111", index);
    expect(byAddress.some((r) => r.group === "proposals")).toBe(true);
    expect(byAddress.some((r) => r.group === "recipients")).toBe(true);
  });

  test("matches owners by label and address", () => {
    const index = {
      proposals,
      owners,
      recipients: buildRecipientIndex(proposals, schedules),
    };
    const byLabel = searchGlobal("alice", index);
    expect(byLabel.some((r) => r.group === "owners" && r.title === "Alice")).toBe(
      true,
    );
    expect(byLabel.find((r) => r.group === "owners")?.to).toBe("/app/owners");

    const byAddr = searchGlobal("GOWNERBOB", index);
    expect(byAddr.some((r) => r.subtitle === "GOWNERBOB000002")).toBe(true);
  });

  test("matches recipients from proposals and schedules", () => {
    const recipients = buildRecipientIndex(proposals, schedules);
    expect(recipients.map((r) => r.address)).toEqual(
      expect.arrayContaining([
        "GRECIPIENTAAA111",
        "GNEWOWNERBBB222",
        "GVESTINGCCC333",
      ]),
    );

    const hits = searchGlobal("GVESTING", {
      proposals,
      owners,
      recipients,
    });
    expect(hits.some((r) => r.group === "recipients")).toBe(true);
    expect(hits.find((r) => r.group === "recipients")?.to).toBe(
      "/app/recurring",
    );
  });

  test("groups results by proposals, owners, and recipients", () => {
    const results = searchGlobal("G", {
      proposals,
      owners,
      recipients: buildRecipientIndex(proposals, schedules),
    });
    const grouped = groupSearchResults(results);
    expect(Object.keys(grouped)).toEqual([
      "proposals",
      "owners",
      "recipients",
    ]);
  });

  test("returns empty list for blank query", () => {
    expect(
      searchGlobal("   ", {
        proposals,
        owners,
        recipients: buildRecipientIndex(proposals, schedules),
      }),
    ).toEqual([]);
  });
});
