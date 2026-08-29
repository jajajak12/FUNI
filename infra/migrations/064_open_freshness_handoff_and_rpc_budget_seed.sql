INSERT INTO state_cache_rpc_budget_leases(lane,owner_id,leased_until_ms,updated_at_ms)
SELECT 'background',owner_id,leased_until_ms,updated_at_ms
FROM rpc_read_work_lease WHERE lease_key='alchemy-read-budget'
ON CONFLICT(lane) DO NOTHING;

CREATE TABLE v4_bid_ladder_open_freshness_handoffs (
  ladder_id TEXT NOT NULL REFERENCES v4_bid_ladders(ladder_id) ON DELETE RESTRICT,
  transaction_hash TEXT NOT NULL COLLATE NOCASE,
  enqueued_at_ms INTEGER NOT NULL CHECK(enqueued_at_ms >= 0),
  PRIMARY KEY(ladder_id,transaction_hash)
);
