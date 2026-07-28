CREATE TABLE targeted_position_reconciliation_requests (
  position_id TEXT PRIMARY KEY REFERENCES positions(id),
  token_id TEXT NOT NULL,
  protocol_version TEXT NOT NULL CHECK (protocol_version IN ('v3','v4')),
  reason TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  requested_at_ms INTEGER NOT NULL,
  available_at_ms INTEGER NOT NULL,
  leased_until_ms INTEGER,
  completed_at_ms INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE INDEX targeted_position_reconciliation_due_idx
  ON targeted_position_reconciliation_requests(priority DESC, available_at_ms, leased_until_ms);
