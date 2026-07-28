CREATE TABLE IF NOT EXISTS v4_live_canary (
  id INTEGER PRIMARY KEY CHECK(id=1),
  state TEXT NOT NULL CHECK(state IN ('AVAILABLE_FOR_OPEN','OPENING','OPENED','CLOSING','CLOSED','FAILED')),
  token_id TEXT,
  open_intent_id TEXT,
  close_intent_id TEXT,
  gas_spent_eth_raw TEXT NOT NULL DEFAULT '0',
  gas_spent_usd REAL NOT NULL DEFAULT 0,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO v4_live_canary(id,state,created_at,updated_at) VALUES(1,'AVAILABLE_FOR_OPEN',datetime('now'),datetime('now'));

CREATE TABLE IF NOT EXISTS v4_live_open_intents (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  owner TEXT NOT NULL,
  telegram_user_id TEXT,
  telegram_chat_id TEXT,
  pool_id TEXT NOT NULL,
  pool_key_json TEXT NOT NULL,
  amount_raw TEXT NOT NULL,
  state TEXT NOT NULL,
  erc20_approval_hash TEXT,
  permit2_approval_hash TEXT,
  mint_hash TEXT,
  token_id TEXT,
  payload_json TEXT NOT NULL,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_v4_live_open_state ON v4_live_open_intents(state);

CREATE TABLE IF NOT EXISTS v4_live_transitions (
  intent_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  state TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(intent_id,ordinal),
  UNIQUE(intent_id,state)
);

CREATE TABLE IF NOT EXISTS v4_live_gas (
  tx_hash TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  estimated_gas TEXT NOT NULL,
  estimated_eth_raw TEXT NOT NULL,
  estimated_usd REAL NOT NULL,
  actual_gas TEXT,
  actual_eth_raw TEXT,
  actual_usd REAL,
  created_at TEXT NOT NULL,
  confirmed_at TEXT
);

CREATE TABLE IF NOT EXISTS v4_pool_selections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  pool_key_json TEXT NOT NULL,
  discovery_block TEXT NOT NULL,
  liquidity_raw TEXT NOT NULL,
  superseded INTEGER NOT NULL DEFAULT 0 CHECK(superseded IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_v4_pool_selection_scope ON v4_pool_selections(user_id,chat_id,session_id,superseded);
