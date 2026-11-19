import { describe, expect, it } from "vitest";
import { AccordParsedEvent, EventSubscription } from "../events.js";

describe("EventSubscription", () => {
  const sampleEvents: AccordParsedEvent[] = [
    {
      id: "hash1:100:0",
      type: "proposal_created",
      contractId: "CD1",
      ledger: 100,
      txHash: "hash1",
      eventIndex: 0,
      timestamp: "2026-11-19T00:00:00Z",
      data: { proposalId: 1 },
    },
    {
      id: "hash2:101:0",
      type: "proposal_approved",
      contractId: "CD1",
      ledger: 101,
      txHash: "hash2",
      eventIndex: 0,
      timestamp: "2026-11-19T00:01:00Z",
      data: { proposalId: 1, approver: "GA1" },
    },
  ];

  it("processes and dispatches events to listeners", () => {
    const sub = new EventSubscription();
    const received: AccordParsedEvent[] = [];
    const created: AccordParsedEvent[] = [];

    sub.on("*", (e) => received.push(e));
    sub.on("proposal_created", (e) => created.push(e));

    const fresh = sub.processEvents(sampleEvents);
    expect(fresh.length).toBe(2);
    expect(received.length).toBe(2);
    expect(created.length).toBe(1);
    expect(sub.cursor).toBe("hash2:101:0");
  });

  it("deduplicates already-processed event IDs", () => {
    const sub = new EventSubscription();
    const received: AccordParsedEvent[] = [];
    sub.on("*", (e) => received.push(e));

    sub.processEvents(sampleEvents);
    expect(received.length).toBe(2);

    // Processing the same batch again should produce zero fresh events
    const secondPass = sub.processEvents(sampleEvents);
    expect(secondPass.length).toBe(0);
    expect(received.length).toBe(2);
  });
});
