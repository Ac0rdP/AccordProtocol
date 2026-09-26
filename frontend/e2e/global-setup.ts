import http from "node:http";
import { handleAnalyticsRoute } from "../src/lib/analyticsApi";
import { ANALYTICS_CONTEXT, ANALYTICS_API_PORT } from "./analytics-fixture";

/**
 * Stands in for the indexer + analytics API service for e2e tests: serves the
 * fixed set of "indexed" events in analytics-fixture.ts through the same
 * request-handling logic (handleAnalyticsRoute) a real backend would run,
 * over a real HTTP server the app's analytics client fetches from.
 */
export default async function globalSetup() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const result = handleAnalyticsRoute(
      req.method ?? "GET",
      url.pathname,
      url.searchParams,
      ANALYTICS_CONTEXT,
    );
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json");
    res.writeHead(result.status);
    res.end(JSON.stringify("data" in result ? result.data : result.error));
  });

  await new Promise<void>((resolve) => server.listen(ANALYTICS_API_PORT, resolve));

  return async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  };
}
