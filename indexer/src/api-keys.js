/**
 * Scoped API keys with per-key request quotas for analytics consumers.
 *
 *   key      acck_<16 hex id>_<64 hex secret>, shown once; only a SHA-256 hash of the secret is stored
 *   scopes   which read endpoints the key may call (ledger, events, reconciliation, subscriptions)
 *   quota    `limit` requests per fixed `windowSeconds` window, counted atomically in the shared store
 *   rotate   issues a new secret for the same key id; the old one keeps working for a grace period
 *   revoke   stops the key at once; revoking twice is a no-op
 *
 * Keys are only enforced when API_KEYS_ENABLED=true. Managing them over HTTP
 * needs OPS_ADMIN_TOKEN, like the webhook retry controls.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { authorizeAdmin } from "./webhook-ops.js";

export const API_KEY_SCOPES = ["ledger", "events", "reconciliation", "subscriptions"];
export const MAX_QUOTA_LIMIT = 10_000_000;
export const MAX_WINDOW_SECONDS = 30 * 24 * 3600;
const KEY_PATTERN = /^acck_([0-9a-f]{16})_([0-9a-f]{64})$/;

const sha256 = (value) => createHash("sha256").update(value).digest();
const hashSecret = (secret) => sha256(secret).toString("hex");

function hashesMatch(expectedHex, secret) {
  if (!expectedHex) return false;
  return timingSafeEqual(Buffer.from(expectedHex, "hex"), sha256(secret));
}

export function generateApiKey() {
  const id = randomBytes(8).toString("hex");
  const secret = randomBytes(32).toString("hex");
  return { id, secret, key: `acck_${id}_${secret}` };
}

export function parseApiKey(raw) {
  const match = typeof raw === "string" ? raw.trim().match(KEY_PATTERN) : null;
  return match ? { id: match[1], secret: match[2] } : null;
}

/** Reads the key from `Authorization: Bearer` or `X-API-Key`; a query string is never accepted. */
export function extractApiKey(request) {
  const authorization = request.headers.authorization ?? "";
  if (authorization.startsWith("Bearer ")) return authorization.slice(7).trim();
  const header = request.headers["x-api-key"];
  return typeof header === "string" ? header.trim() : "";
}

function integerIn(value, name, min, max) {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return number;
}

export function normalizeScopes(scopes) {
  const list = scopes === "*" ? ["*"] : Array.isArray(scopes) ? scopes : null;
  if (!list || list.length === 0) throw new Error(`scopes must be a non-empty list of: ${API_KEY_SCOPES.join(", ")}, or "*"`);
  const expanded = list.flatMap((scope) => (scope === "*" ? API_KEY_SCOPES : [scope]));
  for (const scope of expanded) {
    if (!API_KEY_SCOPES.includes(scope)) throw new Error(`scopes must be a non-empty list of: ${API_KEY_SCOPES.join(", ")}, or "*"`);
  }
  return [...new Set(expanded)].sort();
}

/** Never includes secret material. */
function publicKey(record) {
  const { secretHash: _secretHash, previousSecretHash: _previousSecretHash, ...rest } = record;
  return rest;
}

export function createApiKeyService({ store, config, metrics = null, now = () => Date.now() }) {
  const iso = (ms) => new Date(ms).toISOString();

  function record(result, key) {
    metrics?.apiKeyRequests?.inc({ key, result });
  }

  async function create({ name, scopes, quotaLimit, quotaWindowSeconds, expiresAt }) {
    if (typeof name !== "string" || name.trim() === "" || name.length > 100) throw new Error("name must be 1-100 characters");
    let expires = null;
    if (expiresAt !== undefined && expiresAt !== null) {
      const parsed = new Date(expiresAt);
      if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= now()) throw new Error("expiresAt must be a valid date in the future");
      expires = parsed.toISOString();
    }
    const generated = generateApiKey();
    const created = await store.createApiKey({
      id: generated.id,
      name: name.trim(),
      secretHash: hashSecret(generated.secret),
      scopes: normalizeScopes(scopes),
      quotaLimit: integerIn(quotaLimit ?? config.defaultQuota, "limit", 1, MAX_QUOTA_LIMIT),
      quotaWindowSeconds: integerIn(quotaWindowSeconds ?? config.defaultWindowSeconds, "windowSeconds", 1, MAX_WINDOW_SECONDS),
      expiresAt: expires,
      now: iso(now()),
    });
    if (!created) throw new Error("key id collision; try again");
    return { key: generated.key, apiKey: publicKey(await store.getApiKey(generated.id)) };
  }

  /** @returns {Promise<{key: string, apiKey: object, previousValidUntil: string|null}|null>} null when missing or revoked */
  async function rotate(id, { graceSeconds } = {}) {
    const grace = integerIn(graceSeconds ?? config.rotationGraceSeconds, "graceSeconds", 0, MAX_WINDOW_SECONDS);
    const generated = generateApiKey();
    const graceUntil = grace > 0 ? iso(now() + grace * 1000) : null;
    const updated = await store.rotateApiKey({ id, secretHash: hashSecret(generated.secret), graceUntil, now: iso(now()) });
    if (!updated) return null;
    return { key: `acck_${id}_${generated.secret}`, apiKey: publicKey(updated), previousValidUntil: graceUntil };
  }

  async function revoke(id) {
    return store.revokeApiKey({ id, now: iso(now()) });
  }

  async function list({ status, limit, offset }) {
    return (await store.listApiKeys({ status, limit, offset })).map(publicKey);
  }

  async function get(id) {
    const found = await store.getApiKey(id);
    return found ? publicKey(found) : null;
  }

  /**
   * Authenticates a raw key, checks its scope and counts the request against its quota.
   *
   * @returns {Promise<{ok: true, key: object, quota: object}
   *   | {ok: false, status: number, error: string, quota?: object, retryAfterSeconds?: number}>}
   */
  async function check(rawKey, scope) {
    const parsed = parseApiKey(rawKey);
    const unauthorized = (error = "a valid API key is required") => {
      record("unauthorized", "unknown");
      return { ok: false, status: 401, error };
    };
    if (!parsed) return unauthorized();

    const found = await store.getApiKey(parsed.id);
    const time = now();
    const current = found && hashesMatch(found.secretHash, parsed.secret);
    const previous = found && !current && found.previousSecretHash && found.previousExpiresAt
      && Date.parse(found.previousExpiresAt) > time && hashesMatch(found.previousSecretHash, parsed.secret);
    if (!found || !(current || previous)) return unauthorized();
    if (found.status !== "active") return unauthorized("this API key has been revoked");
    if (found.expiresAt && Date.parse(found.expiresAt) <= time) return unauthorized("this API key has expired");

    if (!found.scopes.includes(scope)) {
      record("forbidden", found.id);
      return { ok: false, status: 403, error: `this API key is not allowed to use the "${scope}" scope` };
    }

    const windowMs = found.quotaWindowSeconds * 1000;
    const windowStart = Math.floor(time / windowMs) * found.quotaWindowSeconds;
    const resetAt = windowStart + found.quotaWindowSeconds;
    const { allowed, used } = await store.consumeApiKeyQuota({
      keyId: found.id, windowStart, limit: found.quotaLimit, now: iso(time),
    });
    const quota = { limit: found.quotaLimit, remaining: Math.max(0, found.quotaLimit - used), resetAt };
    if (!allowed) {
      record("quota_exceeded", found.id);
      return {
        ok: false, status: 429, error: "API key quota exceeded", quota,
        retryAfterSeconds: Math.max(1, resetAt - Math.floor(time / 1000)),
      };
    }
    record("ok", found.id);
    return { ok: true, key: publicKey(found), quota };
  }

  /** Housekeeping: drops counters for windows that ended before the retention period. */
  async function prune() {
    return store.pruneApiKeyUsage({ before: Math.floor(now() / 1000) - config.usageRetentionDays * 86400 });
  }

  return { create, rotate, revoke, list, get, check, prune };
}

const ADMIN_PATH = "/admin/api-keys";
const ADMIN_KEY_PATH = /^\/admin\/api-keys\/([0-9a-f]{16})(?:\/(rotate|revoke))?$/;

/** Route label for metrics, so key ids never become label values. */
export function apiKeyOpsRouteLabel(pathname) {
  if (pathname === ADMIN_PATH) return ADMIN_PATH;
  const match = pathname.match(ADMIN_KEY_PATH);
  if (!match) return null;
  return match[2] ? `${ADMIN_PATH}/:id/${match[2]}` : `${ADMIN_PATH}/:id`;
}

/**
 * Admin endpoints (all need `Authorization: Bearer <OPS_ADMIN_TOKEN>`):
 *
 *   POST /admin/api-keys                 {name, scopes, limit?, windowSeconds?, expiresAt?} -> 201 with the key, once
 *   GET  /admin/api-keys[?status=]       list keys (never secrets)
 *   GET  /admin/api-keys/:id             one key
 *   POST /admin/api-keys/:id/rotate      {graceSeconds?} -> a new key; the old one works until the grace ends
 *   POST /admin/api-keys/:id/revoke      idempotent
 */
export function createApiKeyOps({ service, adminToken, readJson, parsePage }) {
  const sendJson = (response, status, body) => {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify(body));
  };

  /** @returns {Promise<boolean>} true once the request has been answered */
  async function handle(request, response, url) {
    if (!apiKeyOpsRouteLabel(url.pathname)) return false;
    const match = url.pathname.match(ADMIN_KEY_PATH);
    const action = match?.[2];

    const allowedMethod = !match && request.method === "POST" ? true
      : !match && request.method === "GET" ? true
      : match && !action && request.method === "GET" ? true
      : match && action && request.method === "POST";
    if (!allowedMethod) return false;
    if (!authorizeAdmin(request, response, adminToken, "API key management")) return true;

    if (!match) {
      if (request.method === "POST") {
        const body = await readJson(request);
        const result = await service.create({
          name: body.name,
          scopes: body.scopes,
          quotaLimit: body.limit,
          quotaWindowSeconds: body.windowSeconds,
          expiresAt: body.expiresAt,
        });
        sendJson(response, 201, result);
      } else {
        const status = url.searchParams.get("status") ?? undefined;
        if (status && !["active", "revoked"].includes(status)) throw new Error("status must be one of: active, revoked");
        sendJson(response, 200, { keys: await service.list({ status, ...parsePage(url.searchParams) }) });
      }
      return true;
    }

    const id = match[1];
    if (!action) {
      const apiKey = await service.get(id);
      sendJson(response, apiKey ? 200 : 404, apiKey ? { apiKey } : { error: "API key not found" });
    } else if (action === "rotate") {
      const body = await readJson(request);
      const result = await service.rotate(id, { graceSeconds: body.graceSeconds });
      sendJson(response, result ? 200 : 404, result ?? { error: "API key not found or already revoked" });
    } else {
      const { found, changed } = await service.revoke(id);
      sendJson(response, found ? 200 : 404, found ? { revoked: true, changed } : { error: "API key not found" });
    }
    return true;
  }

  return { handle };
}
