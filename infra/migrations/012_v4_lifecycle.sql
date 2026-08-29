CREATE TABLE IF NOT EXISTS v4_positions (
  token_id TEXT PRIMARY KEY,
  protocol_version TEXT NOT NULL DEFAULT 'v4' CHECK(protocol_version='v4'),
  owner TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  pool_key_json TEXT NOT NULL,
  currency0 TEXT NOT NULL,
  currency1 TEXT NOT NULL,
  fee INTEGER NOT NULL,
  tick_spacing INTEGER NOT NULL,
  hooks TEXT NOT NULL,
  tick_lower INTEGER NOT NULL,
  tick_upper INTEGER NOT NULL,
  liquidity_raw TEXT NOT NULL,
  initial_amount0_raw TEXT NOT NULL,
  initial_amount1_raw TEXT NOT NULL,
  claimed_fee0_raw TEXT NOT NULL DEFAULT '0',
  claimed_fee1_raw TEXT NOT NULL DEFAULT '0',
  withdrawn_principal0_raw TEXT NOT NULL DEFAULT '0',
  withdrawn_principal1_raw TEXT NOT NULL DEFAULT '0',
  status TEXT NOT NULL CHECK(status IN ('open','partially_closed','closed','burned')),
  mint_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_v4_positions_owner_status ON v4_positions(owner,status);

CREATE TABLE IF NOT EXISTS v4_lifecycle_intents (
  id TEXT PRIMARY KEY,
  token_id TEXT NOT NULL REFERENCES v4_positions(token_id),
  action TEXT NOT NULL CHECK(action IN ('collect','partial_close','full_close','burn')),
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  liquidity_raw TEXT NOT NULL DEFAULT '0',
  tx_hash TEXT,
  failure_reason TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_v4_lifecycle_token_state ON v4_lifecycle_intents(token_id,state);

CREATE TABLE IF NOT EXISTS v4_lifecycle_receipts (
  tx_hash TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES v4_lifecycle_intents(id),
  receipt_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS v4_lifecycle_transitions (
  intent_id TEXT NOT NULL REFERENCES v4_lifecycle_intents(id),
  ordinal INTEGER NOT NULL,
  state TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(intent_id,ordinal),
  UNIQUE(intent_id,state)
);
