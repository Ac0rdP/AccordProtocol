/**
 * Operations endpoints behind the webhook delivery dashboard.
 *
 *   GET  /ops/webhooks                       the dashboard page
 *   GET  /webhooks/deliveries/summary        outbox size per subscription
 *   GET  /webhooks/deliveries/:id            one delivery: payload plus every attempt
 *   POST /webhooks/deliveries/:id/replay     send one delivery through the dispatcher again
 *   POST /webhooks/deliveries/retry-dead     replay every dead-lettered delivery (?subscription=<id>)
 *
 * Reading is open like the rest of the indexer API. Replaying changes what
 * gets sent to third parties, so it needs `Authorization: Bearer <OPS_ADMIN_TOKEN>`
 * and stays disabled while no (strong enough) token is configured.
 *
 * Replay only flips the outbox row back to pending. The dispatcher (which only
 * runs on the leader) sends it, signing the stored body exactly as the first
 * time, so a replay can never produce different bytes than the original.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { renderWebhookDashboard } from "./ops-dashboard.js";

const SUMMARY_PATH = "/webhooks/deliveries/summary";
const RETRY_DEAD_PATH = "/webhooks/deliveries/retry-dead";
const DELIVERY_PATH = /^\/webhooks\/deliveries\/([^/]+)$/;
const REPLAY_PATH = /^\/webhooks\/deliveries\/([^/]+)\/replay$/;
export const DASHBOARD_PATH = "/ops/webhooks";

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

const digest = (value) => createHash("sha256").update(value).digest();

/** Constant-time token check; hashing first equalizes lengths so none leak. */
export function tokenMatches(expected, provided) {
  if (!expected || !provided) return false;
  return timingSafeEqual(digest(expected), digest(provided));
}

/** Route label for metrics, so ids never become label values. */
export function webhookOpsRouteLabel(pathname) {
  if (pathname === DASHBOARD_PATH || pathname === SUMMARY_PATH || pathname === RETRY_DEAD_PATH) return pathname;
  if (REPLAY_PATH.test(pathname)) return "/webhooks/deliveries/:id/replay";
  if (DELIVERY_PATH.test(pathname)) return "/webhooks/deliveries/:id";
  return null;
}

function parseDeliveryId(raw) {
  if (!/^[1-9]\d{0,14}$/.test(raw)) return null;
  return Number(raw);
}

/** Only the origin of a subscription URL is shown: paths and queries often carry secrets. */
function describeSubscription(subscriptions, id) {
  const subscription = subscriptions.find((candidate) => candidate.id === id);
  if (!subscription) return { id, configured: false, origin: null, topics: null };
  let origin = null;
  try {
    origin = new URL(subscription.url).origin;
  } catch {
    // A malformed URL is shown as unknown rather than echoed back.
  }
  return { id, configured: true, origin, topics: subscription.topics ?? null };
}

export function createWebhookOps({ store, metrics = null, config, subscriptions = [], now = () => Date.now() }) {
  const enabled = config?.enabled ?? true;
  const controlsEnabled = Boolean(config?.adminToken);

  /** @returns {boolean} true once the request has been answered */
  function authorize(request, response) {
    if (!controlsEnabled) {
      sendJson(response, 403, { error: "retry controls are disabled: set OPS_ADMIN_TOKEN (16+ characters) to enable them" });
      return false;
    }
    const header = request.headers.authorization ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!tokenMatches(config.adminToken, provided)) {
      response.setHeader("www-authenticate", 'Bearer realm="accord-indexer-ops"');
      sendJson(response, 401, { error: "a valid admin token is required" });
      return false;
    }
    return true;
  }

  async function handle(request, response, url) {
    if (!enabled) return false;
    const { pathname } = url;
    const label = webhookOpsRouteLabel(pathname);
    if (!label) return false;

    if (pathname === DASHBOARD_PATH) {
      if (request.method !== "GET") return false;
      const nonce = randomBytes(16).toString("base64");
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "content-security-policy": [
          "default-src 'none'",
          `script-src 'nonce-${nonce}'`,
          `style-src 'nonce-${nonce}'`,
          "connect-src 'self'",
          "base-uri 'none'",
          "form-action 'none'",
          "frame-ancestors 'none'",
        ].join("; "),
      });
      response.end(renderWebhookDashboard({ nonce, pageSize: config.pageSize ?? 50, controlsEnabled }));
      return true;
    }

    if (pathname === SUMMARY_PATH) {
      if (request.method !== "GET") return false;
      const [subscriptionRows, totals] = await Promise.all([
        store.summarizeWebhookDeliveries(),
        store.countWebhookDeliveries(),
      ]);
      sendJson(response, 200, {
        totals,
        controlsEnabled,
        subscriptions: subscriptionRows.map((row) => ({
          ...row,
          configured: subscriptions.some((subscription) => subscription.id === row.subscriptionId),
        })),
      });
      return true;
    }

    if (pathname === RETRY_DEAD_PATH) {
      if (request.method !== "POST") return false;
      if (!authorize(request, response)) return true;
      const subscriptionId = url.searchParams.get("subscription") ?? undefined;
      const requeued = await store.requeueDeadWebhookDeliveries({
        subscriptionId,
        now: new Date(now()).toISOString(),
      });
      metrics?.webhookReplays?.inc({ scope: "bulk" }, requeued);
      sendJson(response, 200, { requeued, subscription: subscriptionId ?? null });
      return true;
    }

    const replayMatch = pathname.match(REPLAY_PATH);
    if (replayMatch) {
      if (request.method !== "POST") return false;
      if (!authorize(request, response)) return true;
      const id = parseDeliveryId(replayMatch[1]);
      if (id === null) {
        sendJson(response, 400, { error: "delivery id must be a positive integer" });
        return true;
      }
      const result = await store.replayWebhookDelivery({ id, now: new Date(now()).toISOString() });
      if (!result.found) {
        sendJson(response, 404, { error: "delivery not found" });
        return true;
      }
      // A pending delivery is only made due now; nothing new was queued.
      if (result.previousStatus !== "pending") metrics?.webhookReplays?.inc({ scope: "single" });
      sendJson(response, 200, { replayed: result.previousStatus !== "pending", previousStatus: result.previousStatus, delivery: result.delivery });
      return true;
    }

    const deliveryMatch = pathname.match(DELIVERY_PATH);
    if (deliveryMatch) {
      if (request.method !== "GET") return false;
      const id = parseDeliveryId(deliveryMatch[1]);
      if (id === null) {
        sendJson(response, 400, { error: "delivery id must be a positive integer" });
        return true;
      }
      const delivery = await store.getWebhookDelivery(id);
      if (!delivery) {
        sendJson(response, 404, { error: "delivery not found" });
        return true;
      }
      sendJson(response, 200, {
        delivery,
        attempts: await store.listWebhookDeliveryAttempts(id),
        subscription: describeSubscription(subscriptions, delivery.subscriptionId),
      });
      return true;
    }

    return false;
  }

  return { handle, controlsEnabled };
}
