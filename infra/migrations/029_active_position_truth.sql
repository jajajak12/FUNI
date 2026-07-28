CREATE TABLE active_position_reconciliations (
  position_id TEXT PRIMARY KEY REFERENCES positions(id),
  protocol_version TEXT NOT NULL CHECK (protocol_version IN ('v3','v4')),
  token_id TEXT NOT NULL,
  manager_address TEXT NOT NULL,
  owner_result TEXT,
  owner_status TEXT NOT NULL CHECK (owner_status IN ('VERIFIED_OWNED','VERIFIED_UNOWNED','NONEXISTENT','UNKNOWN')),
  liquidity_raw TEXT,
  claimable0_raw TEXT,
  claimable1_raw TEXT,
  terminal_reason TEXT CHECK (terminal_reason IS NULL OR terminal_reason IN ('TRANSFERRED_OUT','BURNED','CLOSED_EMPTY','REPLACED','OWNERSHIP_LOST')),
  replaced_by_position_id TEXT,
  confirmed_active INTEGER NOT NULL DEFAULT 0 CHECK (confirmed_active IN (0,1)),
  contributes_equity INTEGER NOT NULL DEFAULT 0 CHECK (contributes_equity IN (0,1)),
  check_block TEXT,
  checked_at_ms INTEGER NOT NULL,
  fresh_until_ms INTEGER NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  retry_after_ms INTEGER,
  last_error TEXT,
  details_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX active_position_reconciliation_due_idx
  ON active_position_reconciliations(confirmed_active, fresh_until_ms, retry_after_ms);

CREATE TABLE portfolio_persisted_snapshot (
  snapshot_key TEXT PRIMARY KEY CHECK (snapshot_key = 'current'),
  payload_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  refreshed_at_ms INTEGER NOT NULL,
  last_reconciliation_at_ms INTEGER
);

CREATE TABLE portfolio_refresh_requests (
  request_key TEXT PRIMARY KEY CHECK (request_key = 'current'),
  requested_at_ms INTEGER NOT NULL,
  available_at_ms INTEGER NOT NULL,
  leased_until_ms INTEGER,
  completed_at_ms INTEGER,
  reason TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE TABLE rpc_read_work_lease (
  lease_key TEXT PRIMARY KEY CHECK (lease_key = 'alchemy-read-budget'),
  owner_id TEXT NOT NULL,
  leased_until_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
