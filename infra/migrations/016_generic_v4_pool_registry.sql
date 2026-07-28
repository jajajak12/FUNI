CREATE TABLE IF NOT EXISTS v4_pool_registry (
  pool_id TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL CHECK(chain_id=4663),
  currency0 TEXT NOT NULL,
  currency1 TEXT NOT NULL,
  initialize_fee_raw INTEGER NOT NULL,
  tick_spacing INTEGER NOT NULL,
  hooks TEXT NOT NULL,
  initialization_block TEXT NOT NULL,
  initialization_tx_hash TEXT,
  initialization_tx_index INTEGER,
  initialization_log_index INTEGER,
  first_seen_at TEXT NOT NULL,
  last_refreshed_at TEXT,
  sqrt_price_x96 TEXT,
  current_tick INTEGER,
  active_liquidity_raw TEXT,
  current_protocol_fee INTEGER,
  current_lp_fee_pips INTEGER,
  initialized INTEGER NOT NULL DEFAULT 0 CHECK(initialized IN (0,1)),
  hook_classification TEXT NOT NULL,
  dynamic_fee INTEGER NOT NULL CHECK(dynamic_fee IN (0,1)),
  static_fee_pips INTEGER,
  refresh_block TEXT,
  validation_status TEXT NOT NULL DEFAULT 'DISCOVERED',
  blockers_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  UNIQUE(initialization_tx_hash, initialization_log_index)
);
CREATE INDEX IF NOT EXISTS idx_v4_registry_currency0 ON v4_pool_registry(currency0);
CREATE INDEX IF NOT EXISTS idx_v4_registry_currency1 ON v4_pool_registry(currency1);
CREATE INDEX IF NOT EXISTS idx_v4_registry_eligibility ON v4_pool_registry(validation_status,initialized,dynamic_fee,hook_classification);

CREATE TABLE IF NOT EXISTS v4_pool_discovery_cursor (
  chain_id INTEGER PRIMARY KEY CHECK(chain_id=4663),
  next_block TEXT NOT NULL,
  overlap_blocks INTEGER NOT NULL DEFAULT 12,
  window_size INTEGER NOT NULL DEFAULT 2000,
  last_chain_block TEXT,
  last_sync_started_at TEXT,
  last_sync_completed_at TEXT,
  last_sync_duration_ms INTEGER,
  last_error TEXT,
  fallback_uses INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

ALTER TABLE v4_pool_selections ADD COLUMN target_token TEXT;
ALTER TABLE v4_pool_selections ADD COLUMN funding_token TEXT;
ALTER TABLE v4_pool_selections ADD COLUMN target_index INTEGER;
ALTER TABLE v4_pool_selections ADD COLUMN funding_index INTEGER;
ALTER TABLE v4_pool_selections ADD COLUMN fee_semantics_json TEXT;
ALTER TABLE v4_pool_selections ADD COLUMN hook_status_json TEXT;
ALTER TABLE v4_pool_selections ADD COLUMN refresh_block TEXT;
ALTER TABLE v4_pool_selections ADD COLUMN valuation_snapshot_json TEXT;
ALTER TABLE v4_pool_selections ADD COLUMN eligibility INTEGER NOT NULL DEFAULT 0;
ALTER TABLE v4_pool_selections ADD COLUMN blockers_json TEXT NOT NULL DEFAULT '["LEGACY_INCOMPLETE_SELECTION"]';
ALTER TABLE v4_pool_selections ADD COLUMN expires_at_ms INTEGER;

ALTER TABLE v4_positions ADD COLUMN target_token TEXT;
ALTER TABLE v4_positions ADD COLUMN funding_token TEXT;
ALTER TABLE v4_positions ADD COLUMN target_symbol TEXT;
ALTER TABLE v4_positions ADD COLUMN funding_symbol TEXT;
ALTER TABLE v4_positions ADD COLUMN target_decimals INTEGER;
ALTER TABLE v4_positions ADD COLUMN funding_decimals INTEGER;
ALTER TABLE v4_positions ADD COLUMN target_index INTEGER;
ALTER TABLE v4_positions ADD COLUMN funding_index INTEGER;
ALTER TABLE v4_positions ADD COLUMN fee_semantics_json TEXT;
ALTER TABLE v4_positions ADD COLUMN hook_status_json TEXT;
ALTER TABLE v4_positions ADD COLUMN valuation_provenance_json TEXT;
ALTER TABLE v4_positions ADD COLUMN open_intent_id TEXT;
ALTER TABLE v4_positions ADD COLUMN open_evidence_json TEXT;
