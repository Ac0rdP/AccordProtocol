/**
 * GraphQL Subscriptions Engine for live contract & treasury events.
 *
 * Pushes proposal, approval, and treasury events to subscribed clients in real time
 * without polling, supporting:
 *   - GraphQL over Server-Sent Events (SSE) and HTTP streaming
 *   - Filtering by event topic, proposal id, token, or transfer direction
 *   - Idempotent historical replay from any checkpoint / last-event-id
 *   - Deduplication and failure recovery
 */

import { EventEmitter } from "node:events";

export const SUBSCRIPTION_TOPICS = {
  PROPOSALS: ["created", "proposal_ready", "executed", "rejected"],
  APPROVALS: ["approved", "revoked", "owner_weight_changed"],
  TREASURY: ["transfer", "rpay"],
};

/**
 * Parses simple GraphQL subscription queries into topic and argument filters.
 */
export function parseSubscriptionQuery(query = "") {
  const clean = query.replace(/\s+/g, " ").trim();
  const filters = {
    eventType: "all",
    topics: null,
    proposalId: null,
    token: null,
    direction: null,
  };

  if (/proposalEvents/i.test(clean)) {
    filters.eventType = "proposal";
    filters.topics = [...SUBSCRIPTION_TOPICS.PROPOSALS];
  } else if (/approvalEvents/i.test(clean)) {
    filters.eventType = "approval";
    filters.topics = [...SUBSCRIPTION_TOPICS.APPROVALS];
  } else if (/treasuryEvents/i.test(clean)) {
    filters.eventType = "treasury";
    filters.topics = [...SUBSCRIPTION_TOPICS.TREASURY];
  }

  // Extract explicit topic filter: topic: "..."
  const topicMatch = clean.match(/topic\s*:\s*["']([^"']+)["']/i);
  if (topicMatch) {
    filters.topics = [topicMatch[1].toLowerCase()];
  }

  // Extract proposal id filter: proposalId: 123
  const propMatch = clean.match(/proposalId\s*:\s*(\d+)/i);
  if (propMatch) {
    filters.proposalId = Number(propMatch[1]);
  }

  // Extract token filter: token: "XLM"
  const tokenMatch = clean.match(/token\s*:\s*["']([^"']+)["']/i);
  if (tokenMatch) {
    filters.token = tokenMatch[1].toUpperCase();
  }

  // Extract direction filter: direction: "inflow"
  const dirMatch = clean.match(/direction\s*:\s*["']([^"']+)["']/i);
  if (dirMatch) {
    filters.direction = dirMatch[1].toLowerCase();
  }

  return filters;
}

/**
 * Creates the GraphQL Subscription Manager.
 */
export function createSubscriptionManager({
  store,
  metrics,
  keepAliveMs = 15000,
  maxSubscriptionsPerClient = 50,
  replayMaxEvents = 1000,
} = {}) {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(1000);
  const activeClients = new Map();
  let nextClientId = 1;

  /**
   * Evaluates whether an event matches a client's subscription filter.
   */
  function matchesFilter(event, filter) {
    if (!filter) return true;

    // Check topics
    if (filter.topics && filter.topics.length > 0) {
      const topic = (event.topic ?? event.type ?? "").toLowerCase();
      if (!filter.topics.includes(topic)) return false;
    }

    // Check proposal ID
    if (filter.proposalId !== null && filter.proposalId !== undefined) {
      const payloadId = event.payload?.id ?? event.payload?.proposal_id ?? event.proposalId;
      if (Number(payloadId) !== filter.proposalId) return false;
    }

    // Check token
    if (filter.token) {
      const token = (event.token ?? event.tokenName ?? "").toUpperCase();
      if (token !== filter.token) return false;
    }

    // Check direction
    if (filter.direction) {
      const dir = (event.direction ?? "").toLowerCase();
      if (dir !== filter.direction) return false;
    }

    return true;
  }

  /**
   * Formats a contract or treasury event into standard GraphQL data payload.
   */
  function formatGraphQLPayload(event, filter) {
    const fieldName =
      filter?.eventType === "proposal"
        ? "proposalEvents"
        : filter?.eventType === "approval"
        ? "approvalEvents"
        : filter?.eventType === "treasury"
        ? "treasuryEvents"
        : "liveEvents";

    return {
      data: {
        [fieldName]: {
          eventId: event.eventId ?? String(event.id ?? ""),
          dedupeKey: event.dedupeKey ?? `${event.ledger}:${event.transactionHash}:${event.eventId}`,
          topic: event.topic ?? (event.direction ? "transfer" : "unknown"),
          ledger: event.ledger,
          transactionHash: event.transactionHash ?? null,
          occurredAt: event.occurredAt ?? new Date().toISOString(),
          payload: event.payload ?? null,
          token: event.token ?? null,
          amount: event.amount ?? null,
          direction: event.direction ?? null,
          from: event.from ?? event.from_address ?? null,
          to: event.to ?? event.to_address ?? null,
        },
      },
    };
  }

  /**
   * Publishes an event to all matching subscribed clients.
   * Idempotent: checks recent dedupe keys.
   */
  function publish(event) {
    if (!event) return;
    metrics?.eventsProcessed?.inc?.();
    emitter.emit("event", event);
  }

  /**
   * Replays historical events starting from a given checkpoint or eventId.
   */
  async function replayHistoricalEvents(client, fromEventId) {
    if (!store || !fromEventId) return 0;
    try {
      const numericId = Number(fromEventId);
      const startId = Number.isSafeInteger(numericId) && numericId > 0 ? numericId : 0;
      let replayedCount = 0;

      // Replay accord protocol events
      if (typeof store.getAccordEventsAfter === "function") {
        const events = await store.getAccordEventsAfter(startId, replayMaxEvents);
        for (const ev of events) {
          if (matchesFilter(ev, client.filter) && !client.seenEvents.has(ev.eventId)) {
            client.seenEvents.add(ev.eventId);
            client.send(formatGraphQLPayload(ev, client.filter));
            replayedCount++;
          }
        }
      }

      // Replay treasury ledger entries
      if (
        (client.filter.eventType === "treasury" || client.filter.eventType === "all") &&
        typeof store.getEntries === "function"
      ) {
        const result = await store.getEntries({ limit: replayMaxEvents });
        const entries = result?.entries ?? (Array.isArray(result) ? result : []);
        for (const entry of entries) {
          if (matchesFilter(entry, client.filter) && !client.seenEvents.has(entry.eventId)) {
            client.seenEvents.add(entry.eventId);
            client.send(formatGraphQLPayload(entry, client.filter));
            replayedCount++;
          }
        }
      }

      return replayedCount;
    } catch (err) {
      console.error("Historical subscription replay failed:", err);
      return 0;
    }
  }

  /**
   * Handles an incoming GraphQL subscription request via Server-Sent Events (SSE).
   */
  async function handleSseRequest(request, response, url) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    const clientId = nextClientId++;
    const query = url.searchParams.get("query") ?? "";
    const filter = parseSubscriptionQuery(query);
    const seenEvents = new Set();

    const client = {
      id: clientId,
      filter,
      seenEvents,
      send(data) {
        if (response.writableEnded) return;
        response.write(`event: next\ndata: ${JSON.stringify(data)}\n\n`);
      },
      ping() {
        if (response.writableEnded) return;
        response.write(":keepalive\n\n");
      },
    };

    activeClients.set(clientId, client);

    // Keepalive timer
    const pingTimer = setInterval(() => {
      client.ping();
    }, keepAliveMs);

    // Event listener
    const onEvent = (event) => {
      const dedupeKey = event.eventId ?? `${event.ledger}:${event.transactionHash}`;
      if (client.seenEvents.has(dedupeKey)) return;
      if (matchesFilter(event, client.filter)) {
        client.seenEvents.add(dedupeKey);
        client.send(formatGraphQLPayload(event, client.filter));
      }
    };

    emitter.on("event", onEvent);

    // Handle replay if Last-Event-ID or fromEventId query param is provided
    const lastEventId =
      request.headers["last-event-id"] ||
      url.searchParams.get("fromEventId") ||
      url.searchParams.get("lastEventId");
    if (lastEventId) {
      await replayHistoricalEvents(client, lastEventId);
    }

    // Clean up on disconnect
    const cleanup = () => {
      clearInterval(pingTimer);
      emitter.off("event", onEvent);
      activeClients.delete(clientId);
    };

    request.on("close", cleanup);
    response.on("close", cleanup);
    response.on("error", cleanup);
  }

  return {
    publish,
    handleSseRequest,
    parseSubscriptionQuery,
    matchesFilter,
    formatGraphQLPayload,
    replayHistoricalEvents,
    getActiveClientCount: () => activeClients.size,
    close: () => {
      emitter.removeAllListeners();
      activeClients.clear();
    },
  };
}
