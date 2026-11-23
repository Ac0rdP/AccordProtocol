-- Client checkpoints and durable subscriptions for the GraphQL push engine.
-- Allows clients to register subscriptions and persist last acknowledged event
-- checkpoints across connection drops.

CREATE TABLE IF NOT EXISTS graphql_client_checkpoints (
    client_id TEXT PRIMARY KEY,
    query TEXT NOT NULL,
    last_event_id TEXT,
    last_ledger INTEGER,
    connected_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS graphql_client_checkpoints_updated_idx ON graphql_client_checkpoints (updated_at);
