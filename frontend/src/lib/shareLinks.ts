/**
 * Public share-link, deep-link, and embed-widget URL utilities.
 *
 * Ensures public proposal links (`/proposals/:id`), query-parameter deep links
 * (`/app?proposal=:id`), and iframe embed URLs (`/embed/proposals/:id`,
 * `/embed/treasury`) validate parameters strictly, prevent path traversal, and
 * redact any credential-like material from diagnostic messages.
 */

export type EmbedTheme = "light" | "dark";

export type EmbedOptions = {
  theme?: EmbedTheme;
  compact?: boolean;
};

const STRICT_POSITIVE_INT = /^[1-9]\d*$/;

/**
 * Parses a positive safe integer proposal ID (`1..=Number.MAX_SAFE_INTEGER`).
 * Returns `null` for `0`, negatives, floats, leading zeros, non-numeric strings,
 * path traversal sequences (`../`), or integers exceeding `MAX_SAFE_INTEGER`.
 */
export function parseProposalId(
  raw: string | number | null | undefined,
): number | null {
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && raw >= 1 ? raw : null;
  }
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (!STRICT_POSITIVE_INT.test(trimmed)) {
    return null;
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return null;
  }
  return parsed;
}

/**
 * Parses and normalizes query parameters for `/embed/*` widgets.
 * Unknown or malformed values fall back deterministically to `{ theme: "dark", compact: false }`.
 */
export function parseEmbedParams(search: string): {
  theme: EmbedTheme;
  compact: boolean;
} {
  const params = new URLSearchParams(search);
  const rawTheme = params.get("theme")?.trim().toLowerCase();
  const theme: EmbedTheme = rawTheme === "light" ? "light" : "dark";
  const rawCompact = params.get("compact")?.trim().toLowerCase();
  const compact = rawCompact === "true" || rawCompact === "1";
  return { theme, compact };
}

/**
 * Builds a canonical public share URL for a proposal (`/proposals/:id`).
 */
export function buildProposalShareUrl(
  origin: string,
  proposalId: number,
): string {
  const validId = parseProposalId(proposalId);
  if (validId === null) {
    throw new Error("Proposal ID must be a positive safe integer");
  }
  return new URL(`/proposals/${validId}`, origin).toString();
}

/**
 * Builds an embeddable iframe URL for a proposal (`/embed/proposals/:id`).
 */
export function buildProposalEmbedUrl(
  origin: string,
  proposalId: number,
  options: EmbedOptions = {},
): string {
  const validId = parseProposalId(proposalId);
  if (validId === null) {
    throw new Error("Proposal ID must be a positive safe integer");
  }
  const url = new URL(`/embed/proposals/${validId}`, origin);
  if (options.theme === "light" || options.theme === "dark") {
    url.searchParams.set("theme", options.theme);
  }
  if (options.compact) {
    url.searchParams.set("compact", "true");
  }
  return url.toString();
}

/**
 * Builds an embeddable iframe URL for the treasury summary widget (`/embed/treasury`).
 */
export function buildTreasuryEmbedUrl(
  origin: string,
  options: Pick<EmbedOptions, "theme"> = {},
): string {
  const url = new URL("/embed/treasury", origin);
  if (options.theme === "light" || options.theme === "dark") {
    url.searchParams.set("theme", options.theme);
  }
  return url.toString();
}

/**
 * Determines whether the current route is a public read-only proposal share link
 * or deep link that must render in a signed-out browser (even without Freighter).
 */
export function isPublicShareRoute(pathname: string, search: string): boolean {
  if (/^\/(?:app\/)?proposals\/[^/]+\/?$/.test(pathname)) {
    return true;
  }
  const params = new URLSearchParams(search);
  return params.has("proposal");
}

/**
 * Resolves a public share path (`/proposals/:id`) or query deep link
 * (`?proposal=:id`) to a safe internal `/app/proposals/:id` destination.
 *
 * If a deep-link parameter is malformed or attempts path traversal (such as
 * `?proposal=../settings`), resolves to `/app/proposals/invalid` so the router
 * renders the safe "Proposal not found" view instead of navigating elsewhere.
 */
export function resolvePublicDeepLink(
  pathname: string,
  search: string,
): string | null {
  const directMatch = pathname.match(/^\/proposals\/([^/]+)\/?$/);
  if (directMatch) {
    const validId = parseProposalId(directMatch[1]);
    return validId !== null
      ? `/app/proposals/${validId}`
      : "/app/proposals/invalid";
  }

  const params = new URLSearchParams(search);
  if (params.has("proposal")) {
    const rawProposal = params.get("proposal");
    const validId = parseProposalId(rawProposal);
    return validId !== null
      ? `/app/proposals/${validId}`
      : "/app/proposals/invalid";
  }

  return null;
}

/**
 * Redacts credentials, bearer tokens, or query-string secrets from error messages
 * before surfacing them in the UI or test failure output.
 */
export function redactShareError(input: unknown): string {
  const raw =
    input instanceof Error
      ? input.message
      : typeof input === "string"
        ? input
        : "Unexpected error";
  return raw
    .replace(/\bBearer\s+[A-Za-z0-9._~-]{10,}\b/gi, "Bearer [REDACTED]")
    .replace(
      /\b(https?:\/\/[^:\s"'/@]+:)[^@\s"'/]+(@)/gi,
      "$1[REDACTED]$2",
    )
    .replace(
      /([?&](?:api_key|apiKey|token|access_token|secret|rpc_key)=)[^&\s"'#]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /\b(SECRET|API_TOKEN|ACCESS_TOKEN|PRIVATE_KEY|RPC_KEY)\s*=\s*[^\s"'<>]+/gi,
      "$1=[REDACTED]",
    );
}
