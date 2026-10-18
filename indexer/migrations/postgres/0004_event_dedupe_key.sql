-- Stable chain-position identity for every indexed event
-- (`ledger:transaction:eventIndex`), so reprocessing a ledger can never
-- double-count. Rows indexed before this migration keep a NULL key and remain
-- covered by the `event_id` constraint; NULLs never collide in a unique index.

ALTER TABLE ledger_entries ADD COLUMN dedupe_key TEXT;
ALTER TABLE accord_events ADD COLUMN dedupe_key TEXT;
CREATE UNIQUE INDEX ledger_entries_dedupe_key_idx ON ledger_entries (dedupe_key);
CREATE UNIQUE INDEX accord_events_dedupe_key_idx ON accord_events (dedupe_key);
