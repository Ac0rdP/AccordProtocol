#!/usr/bin/env node

/**
 * check-frontend-headers.mjs — validates frontend CSP and HTTP security headers.
 *
 * Modes:
 *   node scripts/check-frontend-headers.mjs
 *       Verifies frontend/vercel.json against frontend/security-headers.mjs and
 *       checks frontend/index.html for forbidden inline scripts.
 *
 *   node scripts/check-frontend-headers.mjs --url=http://127.0.0.1:4173
 *       Fetches a live HTTP response from the given URL and asserts all required
 *       production security headers are present and strict.
 *
 *   node scripts/check-frontend-headers.mjs --allow-report-only --url=...
 *       Permits Content-Security-Policy-Report-Only during an approved rollback window.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSecurityHeaders,
  DEFAULT_CONNECT_ORIGINS,
} from "../frontend/security-headers.mjs";

const REQUIRED_CSP_DIRECTIVES = [
  "default-src",
  "script-src",
  "style-src",
  "connect-src",
  "img-src",
  "font-src",
  "frame-src",
  "frame-ancestors",
  "base-uri",
  "form-action",
  "object-src",
];

/**
 * Parses a Content-Security-Policy header string into a Map<directive, string[]>.
 */
export function parseCsp(cspHeader) {
  const directives = new Map();
  if (!cspHeader || typeof cspHeader !== "string") return directives;

  for (const segment of cspHeader.split(";")) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    const name = parts[0].toLowerCase();
    const values = parts.slice(1);
    if (directives.has(name)) {
      throw new Error(`Duplicate CSP directive "${name}"`);
    }
    directives.set(name, values);
  }
  return directives;
}

/**
 * Normalizes a header map (plain object or Fetch Headers) to lowercase keys.
 */
export function normalizeHeaders(headers) {
  const normalized = {};
  if (!headers) return normalized;
  if (typeof headers.entries === "function") {
    for (const [k, v] of headers.entries()) {
      normalized[k.toLowerCase()] = String(v);
    }
  } else {
    for (const [k, v] of Object.entries(headers)) {
      normalized[k.toLowerCase()] = String(v);
    }
  }
  return normalized;
}

/**
 * Validates a set of HTTP response headers against the production security policy.
 * Returns `{ ok: boolean, errors: string[], directives: Map<string, string[]> }`.
 */
export function validateSecurityHeaders(
  rawHeaders,
  {
    expectedConnectOrigins = DEFAULT_CONNECT_ORIGINS,
    allowReportOnly = false,
    requireHsts = true,
  } = {},
) {
  const headers = normalizeHeaders(rawHeaders);
  const errors = [];

  const enforcedCsp = headers["content-security-policy"];
  const reportOnlyCsp = headers["content-security-policy-report-only"];

  if (enforcedCsp && reportOnlyCsp) {
    errors.push(
      "Both Content-Security-Policy and Content-Security-Policy-Report-Only are set; configure only one to avoid conflicts.",
    );
  }

  const cspRaw = enforcedCsp || (allowReportOnly ? reportOnlyCsp : null);
  let directives = new Map();

  if (!cspRaw) {
    errors.push(
      allowReportOnly
        ? "Missing Content-Security-Policy (or Content-Security-Policy-Report-Only) header."
        : "Missing enforcing Content-Security-Policy header.",
    );
  } else {
    try {
      directives = parseCsp(cspRaw);
    } catch (err) {
      errors.push(`Invalid CSP syntax: ${err.message}`);
    }
  }

  if (directives.size > 0) {
    for (const required of REQUIRED_CSP_DIRECTIVES) {
      if (!directives.has(required)) {
        errors.push(`CSP is missing required directive: ${required}`);
      }
    }

    const scriptSrc = directives.get("script-src") ?? [];
    if (scriptSrc.includes("'unsafe-inline'")) {
      errors.push("Production script-src must not contain 'unsafe-inline'.");
    }
    if (scriptSrc.includes("'unsafe-eval'")) {
      errors.push("Production script-src must not contain 'unsafe-eval'.");
    }
    if (scriptSrc.some((token) => token.includes("*"))) {
      errors.push("Production script-src must not contain wildcard origins.");
    }
    if (!scriptSrc.includes("'self'")) {
      errors.push("Production script-src must include 'self'.");
    }

    const objectSrc = directives.get("object-src") ?? [];
    if (objectSrc.length !== 1 || objectSrc[0] !== "'none'") {
      errors.push(`object-src must be exactly 'none' (got: ${objectSrc.join(" ")}).`);
    }

    const frameAncestors = directives.get("frame-ancestors") ?? [];
    if (frameAncestors.length !== 1 || frameAncestors[0] !== "'none'") {
      errors.push(`frame-ancestors must be exactly 'none' (got: ${frameAncestors.join(" ")}).`);
    }

    const frameSrc = directives.get("frame-src") ?? [];
    if (frameSrc.length !== 1 || frameSrc[0] !== "'none'") {
      errors.push(`frame-src must be exactly 'none' (got: ${frameSrc.join(" ")}).`);
    }

    const baseUri = directives.get("base-uri") ?? [];
    if (baseUri.length !== 1 || baseUri[0] !== "'self'") {
      errors.push(`base-uri must be exactly 'self' (got: ${baseUri.join(" ")}).`);
    }

    const formAction = directives.get("form-action") ?? [];
    if (formAction.length !== 1 || formAction[0] !== "'self'") {
      errors.push(`form-action must be exactly 'self' (got: ${formAction.join(" ")}).`);
    }

    const connectSrc = directives.get("connect-src") ?? [];
    const allowedConnect = new Set(["'self'", ...expectedConnectOrigins]);
    for (const origin of connectSrc) {
      if (origin.includes("*")) {
        errors.push(`Production connect-src must not contain wildcards: ${origin}`);
      }
      if (origin.includes("?") || origin.includes("@")) {
        errors.push(`Production connect-src must not include query strings or credentials: ${origin}`);
      }
      if (!allowedConnect.has(origin)) {
        errors.push(`Unexpected origin in connect-src: ${origin}`);
      }
    }
    for (const expected of allowedConnect) {
      if (!connectSrc.includes(expected)) {
        errors.push(`Expected origin missing from connect-src: ${expected}`);
      }
    }
  }

  // Required companion security headers
  if (headers["x-content-type-options"] !== "nosniff") {
    errors.push(
      `X-Content-Type-Options must be "nosniff" (got: ${headers["x-content-type-options"] ?? "missing"}).`,
    );
  }

  if (headers["x-frame-options"] !== "DENY") {
    errors.push(`X-Frame-Options must be "DENY" (got: ${headers["x-frame-options"] ?? "missing"}).`);
  }

  if (headers["referrer-policy"] !== "strict-origin-when-cross-origin") {
    errors.push(
      `Referrer-Policy must be "strict-origin-when-cross-origin" (got: ${headers["referrer-policy"] ?? "missing"}).`,
    );
  }

  const permissionsPolicy = headers["permissions-policy"] ?? "";
  for (const feature of ["camera=()", "microphone=()", "geolocation=()"]) {
    if (!permissionsPolicy.includes(feature)) {
      errors.push(`Permissions-Policy must disable ${feature}.`);
    }
  }

  // HSTS check: allowed in production without includeSubDomains or preload
  const hsts = headers["strict-transport-security"];
  if (requireHsts && !hsts) {
    errors.push("Missing Strict-Transport-Security header.");
  }
  if (hsts) {
    if (/includesubdomains/i.test(hsts)) {
      errors.push("Strict-Transport-Security must not set includeSubDomains.");
    }
    if (/preload/i.test(hsts)) {
      errors.push("Strict-Transport-Security must not set preload.");
    }
    if (!/max-age=\d+/i.test(hsts)) {
      errors.push("Strict-Transport-Security must specify max-age.");
    }
  }

  // Guard against headers that break browser wallet extensions / popups
  if (headers["cross-origin-opener-policy"]) {
    errors.push(
      "Cross-Origin-Opener-Policy must not be set without verified wallet popup/extension compatibility.",
    );
  }
  if (headers["cross-origin-embedder-policy"]) {
    errors.push(
      "Cross-Origin-Embedder-Policy must not be set without verified wallet extension compatibility.",
    );
  }

  return { ok: errors.length === 0, errors, directives };
}

/**
 * Extracts headers from frontend/vercel.json for the catch-all "/(.*)" rule.
 */
export function readVercelHeaders(vercelJsonPath) {
  const parsed = JSON.parse(fs.readFileSync(vercelJsonPath, "utf8"));
  const rules = Array.isArray(parsed.headers) ? parsed.headers : [];
  const catchAll = rules.find((rule) => rule.source === "/(.*)");
  if (!catchAll || !Array.isArray(catchAll.headers)) {
    throw new Error(`No catch-all "/(.*)" headers rule found in ${vercelJsonPath}`);
  }
  const map = {};
  for (const entry of catchAll.headers) {
    map[entry.key] = entry.value;
  }
  return map;
}

/**
 * Asserts that frontend/index.html contains no inline <script> blocks (which would
 * require 'unsafe-inline' or per-script hashes in production CSP).
 */
export function checkIndexHtmlNoInlineScripts(indexHtmlPath) {
  const html = fs.readFileSync(indexHtmlPath, "utf8");
  const scriptTagRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  const errors = [];
  let match;
  while ((match = scriptTagRegex.exec(html)) !== null) {
    const attrs = match[1] || "";
    const body = (match[2] || "").trim();
    if (!/\bsrc\s*=/.test(attrs) && body.length > 0) {
      errors.push(
        `Inline <script> found in ${path.basename(indexHtmlPath)}; move to an external script file to keep script-src 'self' strict.`,
      );
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Fetches headers from a live URL and validates them.
 */
export async function checkLiveUrl(url, options = {}) {
  const response = await fetch(url, { method: "GET", redirect: "manual" });
  const result = validateSecurityHeaders(response.headers, options);
  return { status: response.status, ...result };
}

/**
 * Checks that frontend/vercel.json matches the canonical production headers.
 */
export function verifyVercelMatchesCanonical(vercelJsonPath, env = {}) {
  const actual = readVercelHeaders(vercelJsonPath);
  const canonical = buildSecurityHeaders({ mode: "production", env, includeHsts: true });
  const errors = [];

  for (const [key, value] of Object.entries(canonical)) {
    if (actual[key] !== value) {
      errors.push(`vercel.json header "${key}" drifted from canonical security-headers.mjs.`);
    }
  }
  for (const key of Object.keys(actual)) {
    if (!(key in canonical)) {
      errors.push(`vercel.json contains unexpected extra header "${key}".`);
    }
  }

  const validation = validateSecurityHeaders(actual, { requireHsts: true });
  return {
    ok: errors.length === 0 && validation.ok,
    errors: [...errors, ...validation.errors],
  };
}

async function main() {
  const args = process.argv.slice(2);
  const urlArg = args.find((a) => a.startsWith("--url="));
  const allowReportOnly = args.includes("--allow-report-only");
  const skipHsts = args.includes("--no-hsts");

  if (urlArg) {
    const targetUrl = urlArg.slice("--url=".length);
    const result = await checkLiveUrl(targetUrl, {
      allowReportOnly,
      requireHsts: !skipHsts,
    });
    if (!result.ok) {
      console.error(`Security header check FAILED for ${targetUrl}:`);
      for (const err of result.errors) console.error(`  - ${err}`);
      process.exit(1);
    }
    console.log(`OK: Security headers verified on ${targetUrl} (HTTP ${result.status}).`);
    return;
  }

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const vercelPath = path.join(repoRoot, "frontend", "vercel.json");
  const indexPath = path.join(repoRoot, "frontend", "index.html");

  const vercelCheck = verifyVercelMatchesCanonical(vercelPath);
  const htmlCheck = checkIndexHtmlNoInlineScripts(indexPath);
  const allErrors = [...vercelCheck.errors, ...htmlCheck.errors];

  if (allErrors.length > 0) {
    console.error("Frontend security header check FAILED:");
    for (const err of allErrors) console.error(`  - ${err}`);
    process.exit(1);
  }

  console.log("OK: frontend/vercel.json matches canonical strict CSP and frontend/index.html has no inline scripts.");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`Security header check error: ${err.message}`);
    process.exit(1);
  });
}
