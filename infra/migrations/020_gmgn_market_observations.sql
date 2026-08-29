-- Optional read-only market evidence used by manual portfolio and range views.
CREATE TABLE IF NOT EXISTS gmgn_robinhood_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_address TEXT NOT NULL COLLATE NOCASE,
  symbol TEXT,
  name TEXT,
  observed_at_ms INTEGER NOT NULL,
  market_cap_usd REAL,
  source_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_gmgn_robinhood_observations_token_time
  ON gmgn_robinhood_observations(token_address, observed_at_ms DESC);
