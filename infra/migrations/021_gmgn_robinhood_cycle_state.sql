CREATE TABLE IF NOT EXISTS gmgn_robinhood_seen_tokens (
  token_address TEXT PRIMARY KEY COLLATE NOCASE,
  first_seen_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL,
  last_hydrated_at_ms INTEGER,
  last_admission_status TEXT,
  last_snapshot_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_gmgn_robinhood_seen_priority ON gmgn_robinhood_seen_tokens(last_hydrated_at_ms, last_admission_status, last_seen_at_ms);
