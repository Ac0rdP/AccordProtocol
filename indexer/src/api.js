import { createServer } from "node:http";
import { METRICS_CONTENT_TYPE } from "./metrics.js";
import { parseDestination, sendTestNotification } from "./notifications.js";
import { createSubscriptionManager } from "./subscriptions.js";
import { createWebhookOps, webhookOpsRouteLabel } from "./webhook-ops.js";

const ROUTES = new Set([
  "/health", "/healthz", "/readyz", "/status", "/metrics", "/ledger", "/events", "/reconciliation", "/webhooks/deliveries",
  "/notifications/destinations", "/notifications/deliveries", "/graphql", "/graphql/subscriptions",
]);
const DELIVERY_STATUSES = ["pending", "delivered", "dead"];
const DESTINATION_PATH = /^\/notifications\/destinations\/([^/]+)$/;
const DESTINATION_TEST_PATH = /^\/notifications\/destinations\/([^/]+)\/test$/;

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("request body must be valid JSON");
  }
}

/** Strips secrets from a destination before it is ever sent back to a client. */
function redactDestination(destination) {
  const { config, ...rest } = destination;
  const redactedConfig = { ...config };
  if (redactedConfig.secret) redactedConfig.secret = "••••••••";
  return { ...rest, config: redactedConfig };
}

function routeLabelFor(pathname) {
  if (ROUTES.has(pathname)) return pathname;
  const webhookOpsLabel = webhookOpsRouteLabel(pathname);
  if (webhookOpsLabel) return webhookOpsLabel;
  if (DESTINATION_TEST_PATH.test(pathname)) return "/notifications/destinations/:id/test";
  if (DESTINATION_PATH.test(pathname)) return "/notifications/destinations/:id";
  return "unmatched";
}

function parseDateParam(value, name) {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${name} must be a valid date`);
  return parsed.toISOString();
}

function parsePage(searchParams) {
  const limit = Math.min(Math.max(Number(searchParams.get("limit") ?? 100), 1), 1000);
  const offset = Math.max(Number(searchParams.get("offset") ?? 0), 0);
  if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(offset)) {
    throw new Error("limit and offset must be non-negative integers");
  }
  return { limit, offset };
}

/**
 * Structured status for the public status page.
 *
 * `/healthz` and `/readyz` answer a single boolean; the status page has to
 * know *which* dependency is unhappy, so every check is reported on its own.
 * A broken store is an outage, a store that answers while indexing lags is
 * degraded, everything else is operational.
 */
async function buildStatus({ store, readiness, startLedger, finalityLag, election = null }) {
  const { checks } = await readiness.check();
  const status = !checks.store?.ok
    ? "outage"
    : Object.values(checks).every((check) => check.ok)
      ? "operational"
      : "degraded";

  // The store can be exactly what is broken, so reading its state is best effort.
  let nextLedger = String(startLedger);
  let latestLedger = null;
  try {
    nextLedger = (await store.getState("next_ledger")) ?? String(startLedger);
    latestLedger = Number(await store.getState("last_seen_ledger") ?? 0) || null;
  } catch {
    // The checks above already say whether the store is healthy.
  }

  return {
    service: "indexer",
    status,
    checks,
    updatedAt: new Date().toISOString(),
    nextLedger,
    latestLedger,
    finalityLag,
    ...(election ? { leader: election.status() } : {}),
  };
}

/**
 * Builds (without starting) the indexer's HTTP server.
 *
 *   /health /healthz /readyz /status /metrics   operations
 *   /ledger /events /reconciliation     indexed data
 *   /webhooks/deliveries                 outbox inspection (?status=dead for the dead-letter queue,
 *                                        ?subscription=, ?event=, ?order=desc)
 *   /ops/webhooks and /webhooks/deliveries/...  delivery dashboard, attempt history and retry controls (see webhook-ops.js)
 *   GET/PUT/POST /notifications/destinations          list / create / upsert destinations
 *   GET/PUT/POST/DELETE /notifications/destinations/:id  read / upsert / delete one destination
 *   POST /notifications/destinations/:id/test          send a synthetic test event right away
 *   /notifications/deliveries                          outbox inspection (?status=dead, ?destination=<id>)
 */
export function createApi({ store, readiness, metrics, startLedger, finalityLag, tokenAddresses, subscriptions = null, election = null, webhookDashboard = {}, webhookSubscriptions = [] }) {
  const activeSubscriptions = subscriptions ?? createSubscriptionManager({ store, metrics });
  const webhookOps = createWebhookOps({ store, metrics, config: webhookDashboard, subscriptions: webhookSubscriptions });

  async function route(request, response, url) {
    if (
      url.pathname === "/graphql/subscriptions" ||
      (url.pathname === "/graphql" && request.headers.accept?.includes("text/event-stream"))
    ) {
      return activeSubscriptions.handleSseRequest(request, response, url);
    }

    if (url.pathname === "/graphql") {
      if (request.method === "POST") {
        const body = await readJsonBody(request);
        const query = body.query ?? "";
        if (/^\s*subscription/i.test(query)) {
          return sendJson(response, 400, {
            error: "For GraphQL subscriptions, please connect to /graphql/subscriptions via GET or with Accept: text/event-stream",
          });
        }
        if (/introspection|__schema/i.test(query)) {
          return sendJson(response, 200, {
            data: {
              __schema: {
                queryType: { name: "Query" },
                mutationType: null,
                subscriptionType: { name: "Subscription" },
              },
            },
          });
        }
        return sendJson(response, 200, { data: { status: "ok" } });
      }
      if (request.method === "GET") {
        return sendJson(response, 200, {
          schema: "GraphQL Subscriptions available at /graphql/subscriptions",
          types: ["Subscription"],
          subscriptions: ["proposalEvents", "approvalEvents", "treasuryEvents", "liveEvents"],
        });
      }
    }

    if (await webhookOps.handle(request, response, url)) return;

    const destinationMatch = url.pathname.match(DESTINATION_PATH);
    const destinationTestMatch = url.pathname.match(DESTINATION_TEST_PATH);

    if (url.pathname === "/notifications/destinations") {
      if (request.method === "GET") {
        const destinations = await store.listNotificationDestinations();
        return sendJson(response, 200, { destinations: destinations.map(redactDestination) });
      }
      if (request.method === "PUT" || request.method === "POST") {
        const body = await readJsonBody(request);
        const destination = parseDestination(body);
        await store.upsertNotificationDestination({ ...destination, now: new Date().toISOString() });
        return sendJson(response, 200, { destination: redactDestination(destination) });
      }
      return sendJson(response, 404, { error: "not found" });
    }

    if (destinationTestMatch) {
      if (request.method !== "POST") return sendJson(response, 404, { error: "not found" });
      const destination = await store.getNotificationDestination(destinationTestMatch[1]);
      if (!destination) return sendJson(response, 404, { error: "destination not found" });
      const result = await sendTestNotification(destination);
      return sendJson(response, result.ok ? 200 : 502, result);
    }

    if (destinationMatch) {
      const id = destinationMatch[1];
      if (request.method === "GET") {
        const destination = await store.getNotificationDestination(id);
        if (!destination) return sendJson(response, 404, { error: "destination not found" });
        return sendJson(response, 200, { destination: redactDestination(destination) });
      }
      if (request.method === "PUT" || request.method === "POST") {
        const body = await readJsonBody(request);
        const destination = parseDestination({ ...body, id });
        await store.upsertNotificationDestination({ ...destination, now: new Date().toISOString() });
        return sendJson(response, 200, { destination: redactDestination(destination) });
      }
      if (request.method === "DELETE") {
        const deleted = await store.deleteNotificationDestination(id);
        if (!deleted) return sendJson(response, 404, { error: "destination not found" });
        response.writeHead(204);
        return response.end();
      }
      return sendJson(response, 404, { error: "not found" });
    }

    if (url.pathname === "/notifications/deliveries") {
      if (request.method !== "GET") return sendJson(response, 404, { error: "not found" });
      const status = url.searchParams.get("status") ?? undefined;
      if (status && !DELIVERY_STATUSES.includes(status)) {
        throw new Error(`status must be one of: ${DELIVERY_STATUSES.join(", ")}`);
      }
      const deliveries = await store.listNotificationDeliveries({
        status,
        destinationId: url.searchParams.get("destination") ?? undefined,
        ...parsePage(url.searchParams),
      });
      return sendJson(response, 200, { deliveries });
    }

    if (request.method !== "GET") return sendJson(response, 404, { error: "not found" });

    switch (url.pathname) {
      case "/healthz":
        return sendJson(response, 200, { status: "ok" });

      case "/readyz": {
        const result = await readiness.check();
        return sendJson(response, result.ready ? 200 : 503, result);
      }

      case "/status": {
        const status = await buildStatus({ store, readiness, startLedger, finalityLag, election });
        return sendJson(response, status.status === "outage" ? 503 : 200, status);
      }

      case "/metrics":
        response.writeHead(200, { "content-type": METRICS_CONTENT_TYPE });
        return response.end(metrics.render());

      case "/health":
        return sendJson(response, 200, {
          status: "ok",
          nextLedger: (await store.getState("next_ledger")) ?? String(startLedger),
          latestLedger: Number(await store.getState("last_seen_ledger") ?? 0) || null,
          finalityLag,
        });

      case "/ledger": {
        const token = url.searchParams.get("token")?.toUpperCase();
        if (token && !tokenAddresses.has(token)) throw new Error("token must be XLM or USDC");
        const entries = await store.getEntries({
          token,
          from: parseDateParam(url.searchParams.get("from"), "from"),
          to: parseDateParam(url.searchParams.get("to"), "to"),
          ...parsePage(url.searchParams),
        });
        return sendJson(response, 200, { entries });
      }

      case "/events": {
        const events = await store.getAccordEvents({
          topic: url.searchParams.get("topic"),
          from: parseDateParam(url.searchParams.get("from"), "from"),
          to: parseDateParam(url.searchParams.get("to"), "to"),
          ...parsePage(url.searchParams),
        });
        return sendJson(response, 200, { events });
      }

      case "/reconciliation":
        return sendJson(response, 200, { results: await store.getLatestReconciliations() });

      case "/webhooks/deliveries": {
        const status = url.searchParams.get("status") ?? undefined;
        if (status && !DELIVERY_STATUSES.includes(status)) {
          throw new Error(`status must be one of: ${DELIVERY_STATUSES.join(", ")}`);
        }
        const order = url.searchParams.get("order") ?? "asc";
        if (!["asc", "desc"].includes(order)) throw new Error("order must be asc or desc");
        const deliveries = await store.listWebhookDeliveries({
          status,
          subscriptionId: url.searchParams.get("subscription") ?? undefined,
          eventId: url.searchParams.get("event") ?? undefined,
          order,
          ...parsePage(url.searchParams),
        });
        return sendJson(response, 200, { deliveries });
      }

      default:
        return sendJson(response, 404, { error: "not found" });
    }
  }

  return createServer(async (request, response) => {
    const startedAt = performance.now();
    const url = new URL(request.url, "http://localhost");
    // Unknown paths share one label so a scanner cannot blow up metric cardinality.
    const routeLabel = routeLabelFor(url.pathname);
    response.on("finish", () => {
      metrics.httpRequests.inc({ method: request.method, route: routeLabel, status: response.statusCode });
      metrics.httpDuration.observe(
        { method: request.method, route: routeLabel },
        (performance.now() - startedAt) / 1000
      );
    });

    try {
      await route(request, response, url);
    } catch (error) {
      // Input problems are the caller's fault; anything else is the store failing.
      const badRequest = /must be|valid date/.test(error.message);
      if (!badRequest) metrics.errors.inc({ stage: "api" });
      if (!response.headersSent) {
        sendJson(response, badRequest ? 400 : 500, { error: badRequest ? error.message : "internal error" });
      }
      if (!badRequest) console.error("Indexer API request failed:", error);
    }
  });
}
