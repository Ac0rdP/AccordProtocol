# Accord Protocol Indexer

The indexer is a standalone Node.js service that polls the Soroban RPC for events emitted by the Accord Protocol contract and its configured tokens.

## Features

- **Token Transfers**: Indexes `transfer` events from configured tokens to/from the treasury address, tracking balances natively.
- **Accord Protocol Events**: Indexes core protocol events (proposals, roles, thresholds) using the typed catalog and exposes them decoded.
- **Finality**: Only indexes events from ledgers that are final, so the index never runs ahead of the chain.
- **Reorg handling**: Detects a rollback and rewinds indexed data to a consistent point.
- **Backfill & Reindex**: Rebuilds a fresh or damaged deployment from chain history.
- **Reconciliation**: Periodically reads on-chain token balances to detect drift between the indexed state and the live ledger state.

## Architecture

The indexer persists events in a local SQLite database (`data/treasury.sqlite` by default). It maintains state (like `next_ledger` and `event_cursor`) across restarts to ensure no events are missed.

## Running

```bash
npm start                 # serve: run the API and poll for new events
npm run backfill          # index history from the first relevant ledger to now
npm run reindex           # clear the store and rebuild it from chain events
```

Each history command accepts:

- `--from <ledger>` — first ledger to cover. Defaults to the oldest ledger the RPC still retains (its retention window is the practical genesis; history before it is no longer servable).
- `--to <ledger>` — last ledger to cover. Defaults to the final ledger, and is **always clamped to it**: non-final ledgers are never indexed.
- `--json` — emit machine-readable progress lines.

```bash
# Backfill from the RPC's oldest retained ledger, with progress.
npm run backfill

# Backfill a specific range.
node src/index.js backfill --from 1000 --to 2000

# Rebuild everything the RPC can still serve.
npm run reindex
```

### Backfill

Walks a ledger range and ingests its events. It is safe on a fresh deployment
and on an existing one: inserts are keyed by event id, so re-ingesting an overlap
is a no-op, and the running balances are re-folded in chain order
(`ledger ASC, id ASC`) once the walk completes — which is what keeps a backfill
of *older* events into a store that already holds *newer* ones correct.

After a completed backfill the live indexer's checkpoint is advanced to the
first ledger after the covered range, never backwards.

### Reindex

Clears the store (entries, protocol events, balances, reconciliation results)
and re-walks history. An interrupted rebuild leaves `store_rebuilding` set and
its walk checkpoint on disk; the next `reindex` for the **same range** resumes it
instead of wiping the partial progress again. Requesting a *different* range
mid-rebuild starts over cleanly, so a stale partial range is never merged in.

### Resumability and progress

Both commands persist a checkpoint (`<command>_cursor`, `<command>_from`,
`<command>_to`, `<command>_done`) after every page, so a long run can be stopped
and re-run without repeating work. Progress is reported per page and throttled
to at most one line every two seconds; `--json` emits the same data as JSON.

## Ledger finality and reorg policy

Stellar reaches BFT finality on every close: once a ledger closes, any two
validators sharing a quorum intersection agree on it. There is no probabilistic
confirmation depth. The residual risk for an indexer is a *view* problem — the
RPC node being polled can answer from a lagging replica or from a view built on
a ledger a later close supersedes.

The policy, implemented in `src/finality.js`:

- A ledger is final once it is closed **and** at least `LEDGER_FINALITY_LAG`
  further ledgers have closed on top of it:
  `finalLedger(latest) = max(0, latest - LEDGER_FINALITY_LAG)`.
- The default lag is **2** (~two ledger closes, roughly 5s). Set
  `LEDGER_FINALITY_LAG=0` to treat every closed ledger as final.
- Events above the final ledger are **held back**, not dropped: the checkpoint
  parks at the first non-final ledger observed, and those ledgers are re-fetched
  by the next pass once they are final.
- If the observed chain head moves *backwards* (`last_seen_ledger`), that is a
  rollback — the RPC replica restarted on a different ledger or is serving a
  stale view. The store is rewound to `finalLedger(newHead)`, which removes
  exactly the tail corresponding to the regression depth, balances are re-folded
  over what remains, and the walk restarts from the rewound point.

After either event, the indexed state equals the chain state up to the final
ledger — never ahead of it. `indexer/test/finality.test.js` asserts that
invariant after both a not-yet-final ledger and a rollback.

## Endpoints

- `GET /health` - Service health, current ledger state and the finality lag in effect.
- `GET /ledger?token=XLM&limit=100` - Query historical treasury token transfer events.
- `GET /events?topic=created&limit=100` - Query decoded Accord Protocol events.
- `GET /reconciliation` - View latest token balance reconciliation checks.

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `ACCORD_CONTRACT_ID` | yes | Accord contract address |
| `XLM_TOKEN_ADDRESS` | yes | XLM token contract address |
| `USDC_TOKEN_ADDRESS` | yes | USDC token contract address |
| `SIM_SOURCE` | serve only | Funded account used to build simulations |
| `INDEXER_START_LEDGER` | serve only | First ledger for live indexing |
| `SOROBAN_RPC_URL` | no | Soroban RPC endpoint |
| `NETWORK_PASSPHRASE` | no | Stellar network passphrase |
| `LEDGER_FINALITY_LAG` | no | Ledgers to hold back before treating one as final (default 2) |
| `DATABASE_PATH` | no | SQLite file (default `./data/treasury.sqlite`) |

## Tests

```bash
npm test
```

The suite covers the ledger store, the finality and rollback policy, and the
backfill/reindex commands on a small ledger range.
