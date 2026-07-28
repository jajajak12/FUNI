CREATE TABLE wallet_position_sync_cursors (
  protocol_version TEXT PRIMARY KEY CHECK (protocol_version IN ('v3','v4')),
  manager_address TEXT NOT NULL,
  initialized_from_block TEXT NOT NULL,
  next_block TEXT NOT NULL,
  latest_observed_block TEXT NOT NULL,
  window_size INTEGER NOT NULL CHECK (window_size > 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE wallet_position_candidates (
  protocol_version TEXT NOT NULL CHECK (protocol_version IN ('v3','v4')),
  token_id TEXT NOT NULL,
  manager_address TEXT NOT NULL,
  acquisition_tx_hash TEXT NOT NULL,
  acquisition_block TEXT NOT NULL,
  acquisition_log_index INTEGER NOT NULL,
  acquisition_from TEXT NOT NULL,
  last_verified_owner TEXT,
  ownership_verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (protocol_version, token_id)
);

CREATE TABLE position_adoptions (
  position_id TEXT PRIMARY KEY REFERENCES positions(id),
  protocol_version TEXT NOT NULL CHECK (protocol_version IN ('v3','v4')),
  token_id TEXT NOT NULL,
  manager_address TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source = 'MANUAL_EXTERNAL'),
  adoption_status TEXT NOT NULL CHECK (adoption_status = 'AUTO_ADOPTED'),
  accounting_status TEXT NOT NULL,
  discovery_method TEXT NOT NULL,
  mint_tx_hash TEXT,
  mint_block TEXT,
  original_amount0_raw TEXT,
  original_amount1_raw TEXT,
  original_capital_usd REAL,
  baseline_provenance TEXT,
  baseline_set_at TEXT,
  funding_token TEXT,
  funding_symbol TEXT,
  funding_provenance TEXT,
  history_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (protocol_version, token_id)
);

CREATE TABLE adoption_baseline_confirmations (
  id TEXT PRIMARY KEY,
  position_id TEXT NOT NULL REFERENCES position_adoptions(position_id),
  user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  baseline_usd REAL NOT NULL CHECK (baseline_usd > 0),
  state TEXT NOT NULL CHECK (state IN ('AWAITING_CONFIRMATION','CONFIRMED','CANCELLED','EXPIRED')),
  expires_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX wallet_position_candidates_owner_idx
  ON wallet_position_candidates(protocol_version, last_verified_owner);
CREATE INDEX adoption_baseline_pending_idx
  ON adoption_baseline_confirmations(position_id, state, expires_at_ms);
