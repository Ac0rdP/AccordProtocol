// Ledger finality and reorg policy.
//
// Stellar reaches BFT finality on every close: once a ledger is closed, any two
// validators that share a quorum intersection agree on it, so there is no
// probabilistic confirmation depth like there is on proof-of-work chains. The
// residual risk for an indexer is not a consensus reorg but a *view* problem —
// the RPC node we poll can answer from a lagging replica or from a view built
// on a ledger that a later close supersedes.
//
// We therefore only treat a ledger as final once it is closed **and** at least
// `finalityLag` further ledgers have closed on top of it:
//
//     finalLedger(latest) = max(0, latest - finalityLag)
//
// Events from ledgers above `finalLedger` are held back and re-fetched on a
// later pass instead of being indexed. With the default lag of 2 the indexer
// trails the chain head by roughly two ledger closes (~5s on average), which
// is far more than an RPC replica needs to converge and costs nothing in
// correctness because held-back ledgers are picked up by the next pass.
//
// The lag is configurable (`LEDGER_FINALITY_LAG`, or `finalityLag` when calling
// the indexing functions directly). A lag of 0 means "every closed ledger is
// final", which is the strictest reading of Stellar finality and is useful for
// tests and for deployments that trust their RPC node.

/** Ledgers the indexer trails the chain head by before treating one as final. */
export const DEFAULT_FINALITY_LAG = 2;

/**
 * Normalises a user-supplied lag into a safe non-negative integer.
 *
 * @param {unknown} value raw value (env var, CLI flag, or number)
 * @returns {number} the lag to apply
 */
export function resolveFinalityLag(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_FINALITY_LAG;
  const lag = Number(value);
  if (!Number.isSafeInteger(lag) || lag < 0) {
    throw new Error("finality lag must be a non-negative integer");
  }
  return lag;
}

function assertLedger(value, name) {
  const ledger = Number(value);
  if (!Number.isSafeInteger(ledger) || ledger < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return ledger;
}

/**
 * Highest ledger sequence that is safe to index for a chain head.
 *
 * @param {number} latestLedger chain head reported by the RPC
 * @param {number} [lag] confirmations to hold back
 * @returns {number} the final ledger (0 when nothing is final yet)
 */
export function finalLedgerFor(latestLedger, lag = DEFAULT_FINALITY_LAG) {
  const latest = assertLedger(latestLedger, "latestLedger");
  return Math.max(0, latest - resolveFinalityLag(lag));
}

/**
 * Whether an event's ledger may be ingested.
 *
 * @param {number} ledger sequence the event was emitted in
 * @param {number} latestLedger chain head reported by the RPC
 * @param {number} [lag] confirmations to hold back
 * @returns {boolean}
 */
export function isLedgerFinal(ledger, latestLedger, lag = DEFAULT_FINALITY_LAG) {
  return assertLedger(ledger, "ledger") <= finalLedgerFor(latestLedger, lag);
}

/**
 * Detects a rollback: the chain head moved *backwards* relative to the last
 * head we observed. Stellar does not reorg final ledgers, so this means the RPC
 * replica restarted on a different ledger or is serving a stale view — either
 * way the indexed tail can no longer be trusted and has to be rewound.
 *
 * @param {object} params
 * @param {number} params.previousLatestLedger last head we recorded (`last_seen_ledger`)
 * @param {number} params.latestLedger head reported by the current response
 * @param {number} [params.finalityLag] confirmations to hold back
 * @returns {{reorg: true, fromLedger: number, toLedger: number, rewindTo: number} | null}
 */
export function detectReorg({ previousLatestLedger, latestLedger, finalityLag = DEFAULT_FINALITY_LAG }) {
  const previous = Number(previousLatestLedger ?? 0);
  const latest = assertLedger(latestLedger, "latestLedger");
  // Nothing recorded yet, or the head is unchanged/advanced: not a rollback.
  if (!Number.isSafeInteger(previous) || previous <= 0 || latest >= previous) return null;
  return {
    reorg: true,
    fromLedger: previous,
    toLedger: latest,
    rewindTo: finalLedgerFor(latest, finalityLag),
  };
}
