CREATE TABLE direct_token_lookup_requests (
  id TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  token_address TEXT NOT NULL COLLATE NOCASE,
  lookup_version INTEGER NOT NULL,
  dedup_key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  interaction_id TEXT,
  status TEXT NOT NULL CHECK(status IN (
    'QUEUED',
    'RUNNING',
    'SUPPORTED_POOLS_FOUND',
    'NO_ACTIVE_LIQUIDITY_POOL',
    'PROVIDER_TEMPORARILY_UNAVAILABLE',
    'LOOKUP_TIMED_OUT',
    'REQUEST_EXPIRED'
  )),
  candidate_pool_count INTEGER NOT NULL DEFAULT 0,
  hydrated_pool_count INTEGER NOT NULL DEFAULT 0,
  eligible_pool_count INTEGER NOT NULL DEFAULT 0,
  eligible_pool_ids_json TEXT NOT NULL DEFAULT '[]',
  provider_result TEXT,
  rpc_attribution_json TEXT NOT NULL DEFAULT '{}',
  reason_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  deadline_at_ms INTEGER NOT NULL,
  result_expires_at_ms INTEGER NOT NULL,
  leased_until_ms INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  completed_at_ms INTEGER,
  UNIQUE(dedup_key, revision)
);
CREATE INDEX idx_direct_token_lookup_ready
  ON direct_token_lookup_requests(status, deadline_at_ms, leased_until_ms, created_at_ms);
CREATE INDEX idx_direct_token_lookup_dedup
  ON direct_token_lookup_requests(dedup_key, revision DESC);

CREATE TABLE direct_token_lookup_subscribers (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES direct_token_lookup_requests(id),
  request_revision INTEGER NOT NULL,
  interaction_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  attached_at_ms INTEGER NOT NULL,
  UNIQUE(request_id, request_revision, chat_id, message_id)
);

CREATE TABLE direct_token_lookup_outbox (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES direct_token_lookup_requests(id),
  request_revision INTEGER NOT NULL,
  subscriber_id TEXT NOT NULL REFERENCES direct_token_lookup_subscribers(id),
  status TEXT NOT NULL CHECK(status IN ('PENDING','LEASED','DELIVERED','FAILED')),
  payload_json TEXT NOT NULL,
  render_json TEXT,
  render_hash TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at_ms INTEGER NOT NULL,
  leased_until_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  delivered_at_ms INTEGER,
  last_error TEXT,
  UNIQUE(request_id, request_revision, subscriber_id)
);
CREATE INDEX idx_direct_token_lookup_outbox_ready
  ON direct_token_lookup_outbox(status, available_at_ms, leased_until_ms, created_at_ms);
