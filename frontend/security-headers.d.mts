export const DEFAULT_CONNECT_ORIGINS: string[];

export function extractSafeOrigin(
  rawUrl: string,
  options?: { allowInsecure?: boolean },
): string | null;

export function collectConnectOrigins(
  env?: Record<string, string | undefined>,
  options?: { mode?: string },
): string[];

export function buildCspDirectives(
  options?: { mode?: string; env?: Record<string, string | undefined> },
): Record<string, string[]>;

export function serializeCsp(directives: Record<string, string[]>): string;

export function buildSecurityHeaders(options?: {
  mode?: string;
  env?: Record<string, string | undefined>;
  reportOnly?: boolean;
  includeHsts?: boolean;
}): Record<string, string>;
