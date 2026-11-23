/**
 * Treasury outflow anomaly detection.
 *
 * Each outflow (transfers and recurring disbursements both settle as token
 * outflows) is scored against the outflows that came *before it* within the
 * baseline window, using a robust z-score:
 *
 *   score = (amount - median) / max(1.4826 * MAD, median / 10, 1)
 *
 * The median/MAD baseline is not skewed by the very outliers being hunted, and
 * the floor keeps a perfectly regular history (MAD 0) from flagging every tiny
 * deviation. An outflow is flagged when score >= threshold, and never before
 * `minSamples` prior outflows exist. Because each score depends only on earlier
 * entries, the result is a pure, replay-safe function of the deduplicated
 * ledger: nothing is persisted. Amounts are compared as Numbers, which is
 * exact enough for a relative statistic.
 */

const DAY_MS = 86_400_000;
const PAGE = 1000;

function median(sorted) {
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Scores one amount against a baseline of earlier amounts. */
export function scoreOutflow(amount, baseline) {
  const sorted = [...baseline].sort((a, b) => a - b);
  const mid = median(sorted);
  const mad = median(sorted.map((value) => Math.abs(value - mid)).sort((a, b) => a - b));
  const scale = Math.max(1.4826 * mad, mid / 10, 1);
  return { score: (amount - mid) / scale, baselineMedian: mid, baselineSize: sorted.length };
}

/**
 * @param {object[]} entries ledger entries in chain order (`ledger ASC, id ASC`)
 * @returns {object[]} every outflow in the report window with its score and `anomalous` flag
 */
export function detectAnomalies({ entries, now = Date.now(), config }) {
  const reportFrom = now - config.reportDays * DAY_MS;
  const outflows = entries
    .filter((entry) => entry.direction === "outflow")
    .map((entry) => ({ entry, at: Date.parse(entry.occurredAt), amount: Number(entry.amount) }));

  const results = [];
  outflows.forEach(({ entry, at, amount }, index) => {
    if (at < reportFrom || at > now) return;
    const baseline = [];
    for (let i = 0; i < index; i += 1) {
      if (outflows[i].at >= at - config.lookbackDays * DAY_MS) baseline.push(outflows[i].amount);
    }
    const scored = baseline.length >= config.minSamples ? scoreOutflow(amount, baseline) : null;
    results.push({
      eventId: entry.eventId,
      token: entry.token,
      ledger: entry.ledger,
      occurredAt: entry.occurredAt,
      to: entry.to,
      amount: entry.amount,
      score: scored ? Number(scored.score.toFixed(2)) : null,
      baselineMedian: scored ? scored.baselineMedian : null,
      baselineSize: baseline.length,
      anomalous: scored ? scored.score >= config.threshold : false,
    });
  });
  return results;
}

/** Reads the token's entries (paged) and returns the scored outflows plus the flagged subset. */
export async function computeAnomalies({ store, token, config, now = Date.now() }) {
  const from = new Date(now - (config.lookbackDays + config.reportDays) * DAY_MS).toISOString();
  const entries = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await store.getEntries({ token, from, limit: PAGE, offset });
    entries.push(...page);
    if (page.length < PAGE) break;
  }
  const outflows = detectAnomalies({ entries, now, config });
  return { token, outflows, anomalies: outflows.filter((outflow) => outflow.anomalous) };
}
