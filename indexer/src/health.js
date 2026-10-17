/** Default tolerance for "the indexer is still making progress". */
export const DEFAULT_READY_MAX_STALENESS_MS = 60_000;

/**
 * Tracks whether the indexing loop is healthy.
 *
 * Liveness (`/healthz`) only says the process answers. Readiness (`/readyz`)
 * additionally requires the store to respond and a batch to have completed
 * recently, so an orchestrator can stop routing to, or restart, an indexer
 * that is up but wedged (RPC down, database unreachable).
 */
export function createReadiness({ store, maxStalenessMs = DEFAULT_READY_MAX_STALENESS_MS, now = () => Date.now() }) {
  let lastSuccessAt = null;
  let lastError = null;

  return {
    markSuccess() {
      lastSuccessAt = now();
      lastError = null;
    },
    markFailure(error) {
      lastError = String(error?.message ?? error);
    },
    get lastSuccessAt() {
      return lastSuccessAt;
    },

    async check() {
      const checks = {};

      try {
        await store.ping();
        checks.store = { ok: true };
      } catch (error) {
        checks.store = { ok: false, detail: String(error?.message ?? error) };
      }

      if (lastSuccessAt === null) {
        checks.indexing = { ok: false, detail: lastError ?? "waiting for the first indexing batch" };
      } else {
        const ageMs = now() - lastSuccessAt;
        checks.indexing = ageMs <= maxStalenessMs
          ? { ok: true, lastSuccessAgeSeconds: Math.round(ageMs / 1000) }
          : {
              ok: false,
              lastSuccessAgeSeconds: Math.round(ageMs / 1000),
              detail: lastError ?? `no successful batch in ${Math.round(ageMs / 1000)}s`,
            };
      }

      const ready = Object.values(checks).every((check) => check.ok);
      return { ready, status: ready ? "ready" : "not_ready", checks };
    },
  };
}
