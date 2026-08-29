CREATE TABLE IF NOT EXISTS token_metadata_cache (
  address TEXT PRIMARY KEY COLLATE NOCASE,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  decimals INTEGER NOT NULL,
  refreshed_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS v4_state_refresh_queue (
  pool_id TEXT PRIMARY KEY COLLATE NOCASE REFERENCES v4_pool_registry(pool_id),
  priority INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  requested_at_ms INTEGER NOT NULL,
  available_at_ms INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  leased_until_ms INTEGER,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_v4_refresh_ready
  ON v4_state_refresh_queue(available_at_ms, priority DESC, requested_at_ms);

CREATE TABLE IF NOT EXISTS recent_token_requests (
  token_address TEXT PRIMARY KEY COLLATE NOCASE,
  requested_at_ms INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS v3_pool_state_cache (
  pool_address TEXT PRIMARY KEY COLLATE NOCASE,
  factory_address TEXT NOT NULL,
  token0_address TEXT NOT NULL,
  token1_address TEXT NOT NULL,
  fee INTEGER NOT NULL,
  tick_spacing INTEGER NOT NULL,
  liquidity_raw TEXT NOT NULL,
  sqrt_price_x96 TEXT,
  current_tick INTEGER,
  initialized INTEGER NOT NULL,
  refresh_block TEXT NOT NULL,
  tvl_usd REAL,
  refreshed_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_v3_cache_token0 ON v3_pool_state_cache(token0_address);
CREATE INDEX IF NOT EXISTS idx_v3_cache_token1 ON v3_pool_state_cache(token1_address);

CREATE TABLE IF NOT EXISTS latency_telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  provider TEXT,
  fallback_used INTEGER NOT NULL DEFAULT 0,
  cache_age_ms INTEGER,
  context_json TEXT NOT NULL DEFAULT '{}',
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_latency_metric_created
  ON latency_telemetry(metric, created_at_ms DESC);
