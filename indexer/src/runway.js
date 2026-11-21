/**
 * Cash-runway forecast from indexed flows.
 *
 * Pure function of the (deduplicated) ledger entries, the current balance and
 * the configured assumptions, so it is idempotent and safe to recompute at any
 * time or after any replay; nothing is persisted.
 *
 *   netBurn/day = (historical outflow - historical inflow) / window days
 *                 + recurring outflow/day - recurring inflow/day
 *   runway days = balance / netBurn/day   (null when the treasury is not burning)
 *
 * The window is the configured lookback, shortened to the time since the first
 * entry when history is younger than that. All amounts are BigInt base units.
 */

const DAY_MS = 86_400_000;
const PAGE = 1000;

export function forecastRunway({ entries, balance, now = Date.now(), config }) {
  const lookbackMs = config.lookbackDays * DAY_MS;
  const since = now - lookbackMs;
  const inWindow = entries.filter((entry) => {
    const at = Date.parse(entry.occurredAt);
    return at >= since && at <= now;
  });

  let inflow = 0n;
  let outflow = 0n;
  let first = now;
  for (const entry of inWindow) {
    const amount = BigInt(entry.amount);
    if (entry.direction === "inflow") inflow += amount;
    else outflow += amount;
    first = Math.min(first, Date.parse(entry.occurredAt));
  }

  const windowDays = BigInt(Math.max(1, Math.min(config.lookbackDays, Math.ceil((now - first) / DAY_MS))));
  const recurringNet = BigInt(config.recurringOutflowPerDay) - BigInt(config.recurringInflowPerDay);
  // Net burn over the window, scaled by windowDays so no precision is lost to division.
  const scaledBurn = outflow - inflow + recurringNet * windowDays;
  const current = BigInt(balance);

  const result = {
    balance: current.toString(),
    windowDays: Number(windowDays),
    entriesUsed: inWindow.length,
    historicalInflow: inflow.toString(),
    historicalOutflow: outflow.toString(),
    netBurnPerDay: (scaledBurn / windowDays).toString(),
    runwayDays: null,
    depletionDate: null,
    status: "sustainable",
  };

  if (inWindow.length === 0 && recurringNet <= 0n) return { ...result, status: "no_data" };
  if (scaledBurn <= 0n) return result;
  if (current <= 0n) return { ...result, runwayDays: 0, depletionDate: new Date(now).toISOString(), status: "depleted" };

  const runwayDays = Number((current * windowDays) / scaledBurn);
  const capped = runwayDays > config.horizonDays;
  return {
    ...result,
    runwayDays: capped ? config.horizonDays : runwayDays,
    depletionDate: capped ? null : new Date(now + runwayDays * DAY_MS).toISOString(),
    status: capped ? "beyond_horizon" : "burning",
  };
}

/** Reads the token's entries from the store (paged) and forecasts its runway. */
export async function computeRunway({ store, token, config, now = Date.now() }) {
  const from = new Date(now - config.lookbackDays * DAY_MS).toISOString();
  const entries = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await store.getEntries({ token, from, limit: PAGE, offset });
    entries.push(...page);
    if (page.length < PAGE) break;
  }
  return { token, ...forecastRunway({ entries, balance: await store.getBalance(token), now, config }) };
}
