-- Records the contract event-schema version (the `version` field every
-- contract event carries). NULL marks events from pre-versioning deployments.

ALTER TABLE accord_events ADD COLUMN schema_version INTEGER;
