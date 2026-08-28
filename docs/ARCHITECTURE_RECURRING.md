# Recurring Schedule Storage Cost

Recurring schedules add a persistent ledger entry per schedule plus an instance counter. Approximate persistent costs:

- `("RSCH", id)` — `RecurringSchedule` persistent entry (key+value) ~ ~396 bytes → billed as 1 KB for worst-case 30-day bump ≈ ~0.052 XLM per 30 days.
- `RNEXT` — instance counter for next recurring id (stored in instance entry; negligible additional bytes beyond existing instance keys).

Per-schedule cost summary (worst-case full 30-day bump):

- 1 × `("RSCH", id)` entry ≈ 1 KB → ~0.052 XLM / 30 days

Counter costs:

- `RNEXT` stored in the instance entry (shares the same instance TTL bump)
- Any additional small counters (e.g. active schedule counters) should be stored in instance storage to avoid separate persistent entries.

Recommendation: bound active schedules with `MAX_ACTIVE_RECURRING` and enforce a sensible minimum `interval_secs` to limit both rent exposure and the frequency at which keepers need to crank disbursements.
