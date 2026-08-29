CREATE TABLE IF NOT EXISTS direct_token_lookup_candidates (
  request_id TEXT NOT NULL REFERENCES direct_token_lookup_requests(id),
  request_revision INTEGER NOT NULL,
  pool_id TEXT NOT NULL COLLATE NOCASE REFERENCES v4_pool_registry(pool_id),
  state TEXT NOT NULL CHECK(state IN (
    'DISCOVERED','REFRESH_REQUESTED','LEASED','ELIGIBLE','NO_ACTIVE_LIQUIDITY','UNSUPPORTED','EVIDENCE_UNAVAILABLE'
  )),
  reason_code TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  requested_at_ms INTEGER,
  leased_at_ms INTEGER,
  completed_at_ms INTEGER,
  evidence_at_ms INTEGER,
  refresh_block TEXT,
  last_error TEXT,
  PRIMARY KEY(request_id, request_revision, pool_id)
);
CREATE INDEX IF NOT EXISTS idx_direct_lookup_candidates_request
  ON direct_token_lookup_candidates(request_id, request_revision, state);
CREATE INDEX IF NOT EXISTS idx_direct_lookup_candidates_pool
  ON direct_token_lookup_candidates(pool_id, state, completed_at_ms);
