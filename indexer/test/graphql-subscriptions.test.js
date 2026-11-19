import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createSubscriptionManager,
  parseSubscriptionQuery,
  SUBSCRIPTION_TOPICS,
} from "../src/subscriptions.js";
import { resolveGraphQLConfig } from "../src/config.js";
import { openLedgerStore } from "../src/store/sqlite.js";
import { createApi } from "../src/api.js";

describe("GraphQL subscriptions configuration", () => {
  it("resolves default configuration safely", () => {
    const config = resolveGraphQLConfig({});
    assert.equal(config.enabled, true);
    assert.equal(config.path, "/graphql/subscriptions");
    assert.equal(config.keepAliveMs, 15000);
    assert.equal(config.maxSubscriptionsPerClient, 50);
    assert.equal(config.replayMaxEvents, 1000);
  });

  it("applies environment overrides correctly", () => {
    const config = resolveGraphQLConfig({
      GRAPHQL_SUBSCRIPTIONS_ENABLED: "false",
      GRAPHQL_SUBSCRIPTIONS_PATH: "/live-events",
      GRAPHQL_KEEPALIVE_MS: "5000",
      GRAPHQL_MAX_SUBS_PER_CLIENT: "25",
      GRAPHQL_REPLAY_MAX_EVENTS: "500",
    });
    assert.equal(config.enabled, false);
    assert.equal(config.path, "/live-events");
    assert.equal(config.keepAliveMs, 5000);
    assert.equal(config.maxSubscriptionsPerClient, 25);
    assert.equal(config.replayMaxEvents, 500);
  });
});

describe("GraphQL subscription query parser", () => {
  it("parses proposalEvents subscription", () => {
    const filter = parseSubscriptionQuery(`
      subscription {
        proposalEvents(topic: "created") {
          eventId
          topic
        }
      }
    `);
    assert.equal(filter.eventType, "proposal");
    assert.deepEqual(filter.topics, ["created"]);
  });

  it("parses approvalEvents subscription", () => {
    const filter = parseSubscriptionQuery(`
      subscription {
        approvalEvents {
          eventId
        }
      }
    `);
    assert.equal(filter.eventType, "approval");
    assert.deepEqual(filter.topics, SUBSCRIPTION_TOPICS.APPROVALS);
  });

  it("parses treasuryEvents subscription with token and direction", () => {
    const filter = parseSubscriptionQuery(`
      subscription {
        treasuryEvents(token: "USDC", direction: "inflow") {
          eventId
          amount
        }
      }
    `);
    assert.equal(filter.eventType, "treasury");
    assert.equal(filter.token, "USDC");
    assert.equal(filter.direction, "inflow");
  });
});

describe("SubscriptionManager event publishing and filtering", () => {
  it("pushes matching live events to subscribed clients", async () => {
    const manager = createSubscriptionManager();
    const received = [];

    // Simulate an SSE client
    const mockResponse = {
      writableEnded: false,
      writeHead() {},
      write(chunk) {
        if (chunk.startsWith("event: next\ndata: ")) {
          const json = JSON.parse(chunk.replace("event: next\ndata: ", "").trim());
          received.push(json);
        }
      },
      on() {},
    };
    const mockRequest = { headers: {}, on() {} };

    await manager.handleSseRequest(
      mockRequest,
      mockResponse,
      new URL("http://localhost/graphql/subscriptions?query=subscription{proposalEvents}")
    );

    // Publish matching proposal event
    manager.publish({
      eventId: "100:tx1:0",
      dedupeKey: "100:tx1:0",
      topic: "created",
      ledger: 100,
      payload: { id: 1, proposer: "GPROP" },
    });

    // Publish non-matching treasury event
    manager.publish({
      eventId: "101:tx2:0",
      dedupeKey: "101:tx2:0",
      topic: "transfer",
      token: "XLM",
      direction: "inflow",
      amount: "1000",
      ledger: 101,
    });

    assert.equal(received.length, 1);
    assert.equal(received[0].data.proposalEvents.topic, "created");
    assert.equal(received[0].data.proposalEvents.ledger, 100);

    manager.close();
  });

  it("replays historic events when checkpoint is provided and prevents duplicates", async () => {
    const store = openLedgerStore(":memory:");
    const manager = createSubscriptionManager({ store });

    // Seed events into the store
    await store.recordAccordEvent({
      eventId: "50:txA:0",
      dedupeKey: "50:txA:0",
      topic: "created",
      ledger: 50,
      transactionHash: "txA",
      occurredAt: "2026-03-01T00:00:00Z",
      payload: { id: 1 },
      schemaVersion: 1,
    });
    await store.recordAccordEvent({
      eventId: "60:txB:0",
      dedupeKey: "60:txB:0",
      topic: "approved",
      ledger: 60,
      transactionHash: "txB",
      occurredAt: "2026-03-01T01:00:00Z",
      payload: { id: 1 },
      schemaVersion: 1,
    });

    const received = [];
    const mockResponse = {
      writableEnded: false,
      writeHead() {},
      write(chunk) {
        if (chunk.startsWith("event: next\ndata: ")) {
          const json = JSON.parse(chunk.replace("event: next\ndata: ", "").trim());
          received.push(json);
        }
      },
      on() {},
    };
    const mockRequest = { headers: { "last-event-id": "1" }, on() {} };

    await manager.handleSseRequest(
      mockRequest,
      mockResponse,
      new URL("http://localhost/graphql/subscriptions")
    );

    // Historic event after id 1 was replayed
    assert.ok(received.length >= 1);

    // Publishing the same event again does not duplicate
    manager.publish({
      eventId: "60:txB:0",
      dedupeKey: "60:txB:0",
      topic: "approved",
      ledger: 60,
    });

    const approvedCount = received.filter(
      (r) => (r.data.liveEvents?.eventId || r.data.proposalEvents?.eventId) === "60:txB:0"
    ).length;
    assert.equal(approvedCount, 1);

    manager.close();
    await store.close();
  });
});

describe("GraphQL API endpoints routing", () => {
  it("responds to /graphql inspection queries", async () => {
    const store = openLedgerStore(":memory:");
    const readiness = { check: async () => ({ ready: true, checks: { store: { ok: true } } }) };
    const metrics = {
      httpRequests: { inc() {} },
      httpDuration: { observe() {} },
      errors: { inc() {} },
    };
    const api = createApi({
      store,
      readiness,
      metrics,
      startLedger: 1,
      finalityLag: 0,
      tokenAddresses: new Set(["XLM", "USDC"]),
    });

    // Test GET /graphql metadata endpoint
    let statusCode = null;
    let headers = null;
    let body = "";
    const mockRes = {
      writeHead(code, h) {
        statusCode = code;
        headers = h;
      },
      end(payload) {
        body = payload;
      },
      on() {},
    };

    const mockReq = { method: "GET", headers: {} };
    const url = new URL("http://localhost/graphql");

    // Test route directly or through server
    api.emit("request", { ...mockReq, url: "/graphql" }, mockRes);
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(statusCode, 200);
    const parsed = JSON.parse(body);
    assert.ok(parsed.subscriptions.includes("proposalEvents"));

    await store.close();
  });
});
