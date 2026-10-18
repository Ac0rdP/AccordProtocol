# Treasury Analytics

This guide explains the Analytics page — the charts, stat cards, filters, and exports it offers, and how to read the numbers it shows you.

---

## What This Page Is For

Where the [dashboard](reading-the-dashboard.md) shows you individual proposals one card at a time, the Analytics page rolls up your multisig's **executed transfers** into totals and trends: how much has gone out, who's spending it, on what, and when. Only *executed* transfer proposals carry a real monetary amount — governance actions like adding an owner or changing the threshold don't move funds, so they never appear in these numbers.

---

## The Stat Cards

Four cards summarize the current filtered view at a glance:

**Total Outflow** — The sum of every executed transfer amount that matches your current filters. This mixes whatever tokens matched the filter into one number, so set the "token" behavior in mind if your treasury holds more than one token (see [Filters](#filters) below).

**Transactions** — The count of executed transfers matching your filters. Use this alongside Total Outflow to sanity-check whether a large total came from one big payment or many small ones.

**XLM Balance** — The contract's current XLM holdings, read directly from the chain. This is a live balance, not filtered by date range — it answers "what do we have right now," not "what did we spend in this period."

**USDC Balance** — The same, for the contract's current USDC holdings.

---

## The Charts

**Spend by Category** — A bar chart of total spend per proposal category (`Transfer`, `Payroll`, `Grant`, `Ops`, `Other`) within your current filters. Use it to answer "where is our money going" — for example, spotting that payroll dwarfs everything else this quarter.

**Spend by Owner** — A bar chart of total spend grouped by the proposer who created each executed transfer. Hover a bar to see the full proposer address, their spend total, and their transaction count. Use it to see who is initiating the most outgoing value, which is useful for spending-limit reviews (see [Roles & Permissions](roles-and-permissions.md)) even though spending limits and this chart are tracked independently.

**Treasury Outflow Over Time** — A line chart of cumulative outflow by month, built from the same filtered transfers as the two charts above. The line only ever goes up within a filtered range because it's a running total, not a net (inflow minus outflow) figure — it answers "how much has left the treasury so far this period," not "what's our net cash flow."

Each chart shows a loading state while data is being fetched, an error state with a retry button if the fetch fails, and an empty-state message if no transfers match your filters.

---

## Filters

Four filters at the top of the page apply to every stat card and chart at once:

- **From / To** — An inclusive date range. Proposals are matched by deadline, not creation date. Leave either side blank for an open-ended range.
- **Category** — Narrow to one proposal category, or leave it at "All Categories."
- **Owner** — A text filter matched as a substring against the proposer's address (case-insensitive), so you can paste a full address or just enough of it to identify one owner.

Filters reset to their defaults every time you navigate back to this page — they aren't saved between visits, so re-apply them if you return after browsing elsewhere.

---

## Exports

Three export buttons sit above the filters, all disabled when there's no data to export:

**Export Spend CSV** — Downloads the current Spend by Category table as a CSV file (category, total, transaction count), named after your active date filter.

**Export Treasury CSV** — Downloads the current Treasury Outflow Over Time series as a CSV file (period, outflow, cumulative outflow).

**Download Statement (PDF)** — Generates a one-page (or more, if the transaction list is long) PDF statement covering the selected period: a summary (total outflow, transaction count, current XLM and USDC balances), the spend-by-category breakdown, and a line-item list of every matching transfer.

All three exports reflect whatever filters are currently applied — export "All time" first if you want the unfiltered picture before narrowing down.

---

## Data Freshness

The numbers on this page are read from proposals fetched over Soroban RPC when the page loads — they reflect on-chain state as of that read, not a live stream. If a transfer was just executed, refresh the page (or wait for the periodic poll used elsewhere in the app — see [Monitoring Your Multisig](monitoring-your-multisig.md)) to see it reflected here.

Accord Protocol also specifies an analytics HTTP API backed by an off-chain indexer, intended to serve richer historical queries (long date ranges, server-side aggregation) without re-reading every proposal on every page load — see [ARCHITECTURE.md §13](../ARCHITECTURE.md#13-indexer--analytics-architecture) and [ANALYTICS_API.md](../ANALYTICS_API.md) for that design. Once that service is live, figures sourced from it can lag the chain slightly: the indexer processes events in ledger order from a persisted checkpoint, so a transfer that just landed on-chain may take one poll cycle to appear in indexer-backed numbers. Numbers read directly from the contract (like the balance cards on this page today) don't have that lag — they're only as stale as your last page load.

---

## Owner Actions vs Read-Only Visitors

Anyone who can load the dashboard can view the Analytics page — there's no owner-only gate on reading treasury history. As with the [dashboard](reading-the-dashboard.md#owner-actions-vs-read-only-visitors), creating, approving, revoking, or executing proposals still requires a connected wallet that's a registered owner; this page is read-only regardless of who's viewing it.
