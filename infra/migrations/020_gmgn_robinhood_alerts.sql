CREATE TABLE IF NOT EXISTS gmgn_robinhood_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_address TEXT NOT NULL COLLATE NOCASE,
  symbol TEXT,
  name TEXT,
  observed_at_ms INTEGER NOT NULL,
  source_timestamp_ms INTEGER,
  market_cap_usd REAL,
  liquidity_usd REAL,
  volume_1h_usd REAL,
  holder_count INTEGER,
  total_fee_eth REAL,
  trade_fee_raw TEXT,
  priority_fee_raw TEXT,
  fee_semantic_status TEXT NOT NULL,
  fee_observed_at_ms INTEGER NOT NULL,
  token_age_seconds INTEGER,
  launch_platform TEXT,
  top10_pct REAL,
  insider_pct REAL,
  bundled_pct REAL,
  dev_holding_pct REAL,
  security_json TEXT NOT NULL,
  raw_status TEXT NOT NULL,
  raw_version TEXT NOT NULL,
  missing_reasons_json TEXT NOT NULL,
  admission_status TEXT NOT NULL,
  admission_reasons_json TEXT NOT NULL,
  source_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gmgn_robinhood_observations_token_time ON gmgn_robinhood_observations(token_address, observed_at_ms DESC);
CREATE TABLE IF NOT EXISTS gmgn_robinhood_alert_dedupe (
  token_address TEXT NOT NULL COLLATE NOCASE,
  admission_snapshot_hash TEXT NOT NULL,
  alerted_at_ms INTEGER NOT NULL,
  cooldown_until_ms INTEGER NOT NULL,
  PRIMARY KEY(token_address, admission_snapshot_hash)
);
CREATE TABLE IF NOT EXISTS gmgn_robinhood_provider_health (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observed_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  row_count INTEGER NOT NULL,
  hydrated_count INTEGER NOT NULL,
  rate_limited INTEGER NOT NULL,
  error_code TEXT,
  source_version TEXT NOT NULL,
  details_json TEXT NOT NULL
);
