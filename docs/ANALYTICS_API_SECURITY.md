# Analytics API security model

The analytics API is not present in this repository yet; this document is the contract for its implementation. The frontend client enforces the same input bounds before requests and supports bearer authorization without embedding service secrets.

## Access classes

- Public aggregate reads (`/treasury/balance`, `/treasury/flow`, `/spend/by-category`, `/spend/by-owner`, `/stats/summary`) may be anonymous, but must be rate limited per IP and authenticated user at the server.
- Proposal listings and details (`/proposals`, `/proposals/:id`) require a short-lived bearer token. The server must validate signature, expiry, audience, and scope, and return `401` for missing/invalid credentials and `403` for insufficient scope.
- Never expose database credentials, internal indexer endpoints, or unredacted operational metadata through the API.

## Input and abuse controls

Reject unknown query keys, malformed ISO dates, reversed ranges, invalid enum values, owners/tokens over their documented lengths, non-integer pagination, `limit > 100`, and `offset > 1,000,000` with `400`. Use parameterized queries, maximum response sizes, request timeouts, and an allowlisted sort mapping. Apply a default per-client limit of 60 requests/minute for public routes, return `429` with `Retry-After`, and use stricter limits for expensive time-series queries. The server remains authoritative; client throttling is only an additional guard.

## Tests and operations

Tests must cover missing/invalid authorization, insufficient scope, valid access, invalid/reversed/oversized inputs, pagination bounds, public over-limit use, `Retry-After`, and query injection strings. Emit request IDs and aggregate status/latency/rate-limit metrics without logging tokens or query secrets. Review this model whenever an endpoint is added and quarterly thereafter.
