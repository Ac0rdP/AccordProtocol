/**
 * Canonical Content-Security-Policy and HTTP security headers for the Accord frontend.
 *
 * Single source of truth consumed by:
 *   - frontend/vite.config.ts (dev and preview servers)
 *   - scripts/check-frontend-headers.mjs (validates frontend/vercel.json and live HTTP responses)
 *
 * Design constraints:
 *   - Production `script-src` is strictly `'self'` (no `'unsafe-inline'`, no `'unsafe-eval'`).
 *   - Origins are normalized to `scheme://host[:port]` so paths, query parameters, and
 *     credentials can never leak into response headers.
 *   - Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy are intentionally omitted
 *     because restrictive COOP/COEP values can break browser wallet extensions (Freighter)
 *     and wallet popups.
 *   - Strict-Transport-Security is emitted in production HTTPS contexts only, without
 *     `includeSubDomains` or `preload`.
 */

export const DEFAULT_CONNECT_ORIGINS = [
  "https://soroban-testnet.stellar.org",
  "https://horizon-testnet.stellar.org",
  "https://api.coingecko.com",
];

const CONNECT_URL_ENV_KEYS = [
  "VITE_SOROBAN_RPC_URL",
  "VITE_HORIZON_URL",
  "VITE_API_BASE_URL",
  "VITE_INDEXER_API_BASE_URL",
  "VITE_EVENT_PUSH_URL",
  "VITE_WS_URL",
  "VITE_PRICE_FEED_URL",
];

/**
 * Extracts a strict `scheme://host[:port]` origin from a URL string.
 * Rejects wildcards, embedded credentials, non-HTTP(S)/WS(S) schemes, and invalid URLs.
 * Returns `null` for empty or relative URLs (which are already covered by `'self'`).
 */
export function extractSafeOrigin(rawUrl, { allowInsecure = false } = {}) {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.startsWith("/")) return null;
  if (trimmed.includes("*")) {
    throw new Error(`Wildcard origin is not allowed in CSP: ${trimmed}`);
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid URL configured for CSP origin: ${trimmed}`);
  }

  if (parsed.username || parsed.password) {
    throw new Error(`URL with embedded credentials is not allowed in CSP: ${parsed.origin}`);
  }

  const allowedProtocols = allowInsecure
    ? new Set(["https:", "wss:", "http:", "ws:"])
    : new Set(["https:", "wss:"]);

  if (!allowedProtocols.has(parsed.protocol)) {
    throw new Error(
      `Disallowed protocol "${parsed.protocol}" in CSP origin (allowed: ${[...allowedProtocols].join(", ")})`,
    );
  }

  return `${parsed.protocol}//${parsed.host}`;
}

/**
 * Collects deduplicated `connect-src` origins from environment variables and defaults.
 */
export function collectConnectOrigins(env = {}, { mode = "production" } = {}) {
  const isDev = mode === "development";
  const origins = new Set(["'self'", ...DEFAULT_CONNECT_ORIGINS]);

  for (const key of CONNECT_URL_ENV_KEYS) {
    const val = env[key];
    if (!val) continue;
    const origin = extractSafeOrigin(val, { allowInsecure: isDev });
    if (origin) origins.add(origin);
  }

  const extraRaw = env.VITE_CSP_EXTRA_CONNECT_SRC || env.CSP_EXTRA_CONNECT_SRC || "";
  for (const part of String(extraRaw).split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const origin = extractSafeOrigin(trimmed, { allowInsecure: isDev });
    if (origin) origins.add(origin);
  }

  if (isDev) {
    origins.add("ws://localhost:*");
    origins.add("ws://127.0.0.1:*");
    origins.add("http://localhost:*");
    origins.add("http://127.0.0.1:*");
  }

  return [...origins];
}

/**
 * Builds the CSP directive map for the requested mode.
 */
export function buildCspDirectives({ mode = "production", env = {} } = {}) {
  const isDev = mode === "development";
  const connectSrc = collectConnectOrigins(env, { mode });

  return {
    "default-src": ["'self'"],
    // Vite dev server injects an inline HMR preamble; production uses strictly `'self'`.
    "script-src": isDev ? ["'self'", "'unsafe-inline'"] : ["'self'"],
    // Recharts and Tailwind/React dynamic inline styles require `'unsafe-inline'` for styles.
    "style-src": ["'self'", "'unsafe-inline'"],
    "connect-src": connectSrc,
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'", "data:"],
    "frame-src": ["'none'"],
    "frame-ancestors": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "object-src": ["'none'"],
    "worker-src": ["'self'"],
    "manifest-src": ["'self'"],
  };
}

/**
 * Serializes a directive map to a Content-Security-Policy header value.
 */
export function serializeCsp(directives) {
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}

/**
 * Builds the complete set of HTTP security headers for the Accord frontend.
 *
 * Options:
 *   - mode: "production" | "development" (default: "production")
 *   - env: environment variable map (default: {})
 *   - reportOnly: serve CSP as Content-Security-Policy-Report-Only for fast rollback
 *   - includeHsts: emit Strict-Transport-Security (default: true in production, false in dev)
 */
export function buildSecurityHeaders({
  mode = "production",
  env = {},
  reportOnly = false,
  includeHsts = mode === "production",
} = {}) {
  const isReportOnly =
    Boolean(reportOnly) ||
    env.CSP_REPORT_ONLY === "true" ||
    env.VITE_CSP_REPORT_ONLY === "true";

  const cspHeaderName = isReportOnly
    ? "Content-Security-Policy-Report-Only"
    : "Content-Security-Policy";

  const cspValue = serializeCsp(buildCspDirectives({ mode, env }));

  const headers = {
    [cspHeaderName]: cspValue,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    // Do not restrict usb/hid/publickey-credentials-get so Ledger & Passkey wallets continue to work.
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), interest-cohort=()",
  };

  if (includeHsts && mode === "production") {
    // Intentionally omits `includeSubDomains` and `preload`.
    headers["Strict-Transport-Security"] = "max-age=31536000";
  }

  return headers;
}
