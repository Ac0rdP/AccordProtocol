import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildSecurityHeaders,
  collectConnectOrigins,
  extractSafeOrigin,
} from "../frontend/security-headers.mjs";
import {
  checkIndexHtmlNoInlineScripts,
  checkLiveUrl,
  validateSecurityHeaders,
  verifyVercelMatchesCanonical,
} from "./check-frontend-headers.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("canonical production headers pass strict validation", () => {
  const headers = buildSecurityHeaders({ mode: "production" });
  const result = validateSecurityHeaders(headers);
  assert.equal(result.ok, true, `Expected valid headers, got errors: ${result.errors.join("; ")}`);
  assert.ok(headers["Content-Security-Policy"]);
  assert.equal(headers["Content-Security-Policy-Report-Only"], undefined);
  assert.equal(headers["Strict-Transport-Security"], "max-age=31536000");
});

test("frontend/vercel.json matches canonical production headers and passes validation", () => {
  const vercelPath = path.join(REPO_ROOT, "frontend", "vercel.json");
  const result = verifyVercelMatchesCanonical(vercelPath);
  assert.equal(result.ok, true, `vercel.json check failed: ${result.errors.join("; ")}`);
});

test("regression fixture: frontend/index.html contains no inline <script> blocks", () => {
  const indexPath = path.join(REPO_ROOT, "frontend", "index.html");
  const result = checkIndexHtmlNoInlineScripts(indexPath);
  assert.equal(result.ok, true, `index.html check failed: ${result.errors.join("; ")}`);
});

test("development mode allows Vite HMR without polluting production policy", () => {
  const devHeaders = buildSecurityHeaders({ mode: "development" });
  const prodHeaders = buildSecurityHeaders({ mode: "production" });

  assert.match(devHeaders["Content-Security-Policy"], /script-src 'self' 'unsafe-inline'/);
  assert.equal(devHeaders["Strict-Transport-Security"], undefined);

  assert.doesNotMatch(prodHeaders["Content-Security-Policy"], /script-src[^;]*'unsafe-inline'/);
  assert.doesNotMatch(prodHeaders["Content-Security-Policy"], /script-src[^;]*'unsafe-eval'/);
});

test("report-only rollback switch serves Content-Security-Policy-Report-Only", () => {
  const headers = buildSecurityHeaders({
    mode: "production",
    env: { VITE_CSP_REPORT_ONLY: "true" },
  });

  assert.equal(headers["Content-Security-Policy"], undefined);
  assert.ok(headers["Content-Security-Policy-Report-Only"]);

  // Enforcing check rejects report-only unless explicitly allowed
  const strictResult = validateSecurityHeaders(headers);
  assert.equal(strictResult.ok, false);

  const rollbackResult = validateSecurityHeaders(headers, { allowReportOnly: true });
  assert.equal(rollbackResult.ok, true, rollbackResult.errors.join("; "));
});

test("origin extraction strips paths/queries and rejects secrets, wildcards, and HTTP in prod", () => {
  assert.equal(
    extractSafeOrigin("https://api.accord.example/v1/proposals?token=should-never-appear"),
    "https://api.accord.example",
  );
  assert.equal(extractSafeOrigin("wss://events.accord.example/ws"), "wss://events.accord.example");
  assert.equal(extractSafeOrigin("/api"), null);

  assert.throws(() => extractSafeOrigin("https://user:secret@api.accord.example"), /credentials/i);
  assert.throws(() => extractSafeOrigin("https://*.accord.example"), /wildcard/i);
  assert.throws(() => extractSafeOrigin("http://insecure.accord.example"), /disallowed protocol/i);

  const origins = collectConnectOrigins({
    VITE_API_BASE_URL: "https://analytics.accord.example/api/v1",
    VITE_EVENT_PUSH_URL: "wss://push.accord.example/events",
  });
  assert.ok(origins.includes("https://analytics.accord.example"));
  assert.ok(origins.includes("wss://push.accord.example"));
  assert.ok(origins.every((o) => !o.includes("/api/v1")));
});

test("failure fixture: deliberately weakened CSP with unsafe-inline or unsafe-eval is rejected", () => {
  const base = buildSecurityHeaders({ mode: "production" });

  const withUnsafeInline = {
    ...base,
    "Content-Security-Policy": base["Content-Security-Policy"].replace(
      "script-src 'self'",
      "script-src 'self' 'unsafe-inline'",
    ),
  };
  const inlineRes = validateSecurityHeaders(withUnsafeInline);
  assert.equal(inlineRes.ok, false);
  assert.ok(inlineRes.errors.some((e) => e.includes("'unsafe-inline'")));

  const withUnsafeEval = {
    ...base,
    "Content-Security-Policy": base["Content-Security-Policy"].replace(
      "script-src 'self'",
      "script-src 'self' 'unsafe-eval'",
    ),
  };
  const evalRes = validateSecurityHeaders(withUnsafeEval);
  assert.equal(evalRes.ok, false);
  assert.ok(evalRes.errors.some((e) => e.includes("'unsafe-eval'")));
});

test("failure fixture: unexpected origin, HSTS preload, and COOP/COEP are rejected", () => {
  const base = buildSecurityHeaders({ mode: "production" });

  const weakened = {
    ...base,
    "Content-Security-Policy": base["Content-Security-Policy"].replace(
      "connect-src 'self'",
      "connect-src 'self' https://evil.example",
    ),
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
  };
  const res = validateSecurityHeaders(weakened);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("https://evil.example")));
  assert.ok(res.errors.some((e) => e.includes("includeSubDomains")));
  assert.ok(res.errors.some((e) => e.includes("preload")));
  assert.ok(res.errors.some((e) => e.includes("Cross-Origin-Opener-Policy")));
  assert.ok(res.errors.some((e) => e.includes("Cross-Origin-Embedder-Policy")));
});

test("live HTTP response verification passes against a server emitting canonical headers", async () => {
  const headers = buildSecurityHeaders({ mode: "production" });
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...headers });
    res.end("<!doctype html><html><body>ok</body></html>");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const result = await checkLiveUrl(`http://127.0.0.1:${port}/`);
    assert.equal(result.ok, true, result.errors.join("; "));
    assert.equal(result.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
