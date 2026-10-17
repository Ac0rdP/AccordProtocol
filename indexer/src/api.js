import { createServer } from "node:http";
import { METRICS_CONTENT_TYPE } from "./metrics.js";

const ROUTES = new Set([
  "/health", "/healthz", "/readyz", "/metrics", "/ledger", "/events", "/reconciliation", "/webhooks/deliveries",
]);
const DELIVERY_STATUSES = ["pending", "delivered", "dead"];

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
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
 * Builds (without starting) the indexer's HTTP server.
 *
 *   /health /healthz /readyz /metrics   operations
 *   /ledger /events /reconciliation     indexed data
 *   /webhooks/deliveries                outbox inspection (?status=dead for the dead-letter queue)
 */
export function createApi({ store, readiness, metrics, startLedger, finalityLag, tokenAddresses }) {
  async function route(request, response, url) {
    if (request.method !== "GET") return sendJson(response, 404, { error: "not found" });

    switch (url.pathname) {
      case "/healthz":
        return sendJson(response, 200, { status: "ok" });

      case "/readyz": {
        const result = await readiness.check();
        return sendJson(response, result.ready ? 200 : 503, result);
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
        const deliveries = await store.listWebhookDeliveries({
          status,
          subscriptionId: url.searchParams.get("subscription") ?? undefined,
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
    const routeLabel = ROUTES.has(url.pathname) ? url.pathname : "unmatched";
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
