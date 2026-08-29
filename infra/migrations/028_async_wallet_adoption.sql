ALTER TABLE wallet_position_candidates ADD COLUMN candidate_state TEXT NOT NULL DEFAULT 'DISCOVERED'
  CHECK (candidate_state IN ('DISCOVERED','OWNERSHIP_VERIFIED','ADOPTED','FINALIZED_UNOWNED','BURNED','RETRYABLE_ERROR'));
ALTER TABLE wallet_position_candidates ADD COLUMN state_reason TEXT;
ALTER TABLE wallet_position_candidates ADD COLUMN relevant_transfer_at TEXT;
ALTER TABLE wallet_position_candidates ADD COLUMN retry_after_ms INTEGER;

CREATE INDEX wallet_position_candidates_state_idx
  ON wallet_position_candidates(candidate_state, retry_after_ms, ownership_verified_at);

CREATE TABLE wallet_position_sync_requests (
  request_key TEXT PRIMARY KEY CHECK (request_key = 'wallet'),
  requested_at_ms INTEGER NOT NULL,
  available_at_ms INTEGER NOT NULL,
  leased_until_ms INTEGER,
  completed_at_ms INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  last_error TEXT
);

CREATE TABLE position_detail_refresh_state (
  protocol_version TEXT NOT NULL CHECK (protocol_version IN ('v3','v4')),
  token_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  refreshed_at_ms INTEGER NOT NULL,
  PRIMARY KEY (protocol_version, token_id)
);
