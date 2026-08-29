-- Durable optimistic concurrency for Telegram interaction state.
ALTER TABLE telegram_flow_sessions
  ADD COLUMN flow_revision INTEGER NOT NULL DEFAULT 0;

-- A direct-lookup subscriber may mutate flow state only at the revision from
-- which its pool-listing request originated. Legacy subscribers fail closed.
ALTER TABLE direct_token_lookup_subscribers
  ADD COLUMN base_flow_revision INTEGER;
