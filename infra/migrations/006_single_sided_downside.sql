-- Additive strategy metadata; legacy balanced and fork positions remain readable.
CREATE TABLE IF NOT EXISTS position_strategy_details (
  position_id TEXT PRIMARY KEY REFERENCES positions(id),
  strategy_mode TEXT NOT NULL DEFAULT 'BALANCED' CHECK(strategy_mode IN ('BALANCED','SINGLE_SIDED_DOWNSIDE')),
  target_token TEXT,
  funding_token TEXT,
  upper_drop_pct REAL,
  lower_drop_pct REAL,
  requested_upper_price REAL,
  requested_lower_price REAL,
  actual_upper_price REAL,
  actual_lower_price REAL,
  tick_lower INTEGER,
  tick_upper INTEGER,
  initial_funding_raw TEXT,
  target_desired_raw TEXT,
  funding_desired_raw TEXT,
  benchmark_asset TEXT,
  intent_json TEXT NOT NULL DEFAULT '{}',
  simulation_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS position_strategy_details_mode ON position_strategy_details(strategy_mode);
