# Accord Protocol Indexer

The indexer is a standalone Node.js service that polls the Soroban RPC for events emitted by the Accord Protocol contract and its configured tokens.

## Features

- **Token Transfers**: Indexes `transfer` events from configured tokens to/from the treasury address, tracking balances natively.
- **Accord Protocol Events**: Indexes core protocol events (proposals, roles, thresholds) using the typed catalog and exposes them decoded.
- **Reconciliation**: Periodically reads on-chain token balances to detect drift between the indexed state and the live ledger state.

## Architecture

The indexer persists events in a local SQLite database (`data/treasury.sqlite` by default). It maintains state (like `next_ledger` and `event_cursor`) across restarts to ensure no events are missed.

## Endpoints

- `GET /health` - Service health and current ledger state.
- `GET /ledger?token=XLM&limit=100` - Query historical treasury token transfer events.
- `GET /events?topic=created&limit=100` - Query decoded Accord Protocol events.
- `GET /reconciliation` - View latest token balance reconciliation checks.
