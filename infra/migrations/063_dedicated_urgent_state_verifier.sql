ALTER TABLE targeted_position_reconciliation_requests RENAME TO targeted_position_reconciliation_requests_pre_urgent_lane;

CREATE TABLE targeted_position_reconciliation_requests (
  position_id TEXT NOT NULL REFERENCES positions(id),
  lane TEXT NOT NULL CHECK(lane IN ('urgent','background')),
  token_id TEXT NOT NULL,
  protocol_version TEXT NOT NULL CHECK(protocol_version IN ('v3','v4')),
  reason TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  requested_at_ms INTEGER NOT NULL,
  available_at_ms INTEGER NOT NULL,
  leased_until_ms INTEGER,
  leased_at_ms INTEGER,
  lease_owner TEXT,
  completed_at_ms INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  chain_id INTEGER NOT NULL DEFAULT 4663,
  protocol TEXT NOT NULL DEFAULT 'uniswap_v4',
  PRIMARY KEY(position_id,lane)
);

INSERT INTO targeted_position_reconciliation_requests(
  position_id,lane,token_id,protocol_version,reason,priority,requested_at_ms,
  available_at_ms,leased_until_ms,completed_at_ms,attempts,last_error,chain_id,protocol
)
SELECT position_id,
  CASE WHEN reason IN (
    'OPERATIONAL_MINT_CONFIRMED','ECONOMIC_CLOSE_RECEIPT_CONFIRMED',
    'OPERATOR_TARGETED_RECONCILIATION','OPERATOR_KNOWN_EXTERNAL_V4_IMPORT',
    'FALSE_OWNERSHIP_LOSS_RECOVERY'
  ) THEN 'urgent' ELSE 'background' END,
  token_id,protocol_version,reason,priority,requested_at_ms,available_at_ms,
  leased_until_ms,completed_at_ms,attempts,last_error,chain_id,protocol
FROM targeted_position_reconciliation_requests_pre_urgent_lane;

DROP TABLE targeted_position_reconciliation_requests_pre_urgent_lane;

CREATE INDEX targeted_position_reconciliation_due_idx
  ON targeted_position_reconciliation_requests(lane,priority DESC,available_at_ms,leased_until_ms);

ALTER TABLE v4_state_refresh_queue RENAME TO v4_state_refresh_queue_pre_urgent_lane;

CREATE TABLE v4_state_refresh_queue (
  pool_id TEXT NOT NULL COLLATE NOCASE REFERENCES v4_pool_registry(pool_id),
  lane TEXT NOT NULL CHECK(lane IN ('urgent','background')),
  priority INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  requested_at_ms INTEGER NOT NULL,
  available_at_ms INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  leased_until_ms INTEGER,
  leased_at_ms INTEGER,
  lease_owner TEXT,
  last_error TEXT,
  PRIMARY KEY(pool_id,lane)
);

INSERT INTO v4_state_refresh_queue(
  pool_id,lane,priority,reason,requested_at_ms,available_at_ms,attempts,
  leased_until_ms,last_error
)
SELECT pool_id,
  CASE WHEN reason IN (
    'OPERATIONAL_OPEN_POOL_FRESHNESS','REPOSITION_ON_DEMAND_POOL_FRESHNESS'
  ) THEN 'urgent' ELSE 'background' END,
  priority,reason,requested_at_ms,available_at_ms,attempts,leased_until_ms,last_error
FROM v4_state_refresh_queue_pre_urgent_lane;

DROP TABLE v4_state_refresh_queue_pre_urgent_lane;

CREATE INDEX idx_v4_refresh_ready
  ON v4_state_refresh_queue(lane,available_at_ms,priority DESC,requested_at_ms);

CREATE TABLE state_cache_rpc_budget_leases (
  lane TEXT PRIMARY KEY CHECK(lane IN ('urgent','background')),
  owner_id TEXT NOT NULL,
  leased_until_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE state_cache_persistence_lease (
  lease_key TEXT PRIMARY KEY CHECK(lease_key='canonical-state-persistence'),
  owner_id TEXT NOT NULL,
  leased_until_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
