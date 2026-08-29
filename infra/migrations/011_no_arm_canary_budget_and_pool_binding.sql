-- Historical canary_arms rows remain untouched for audit compatibility.
CREATE TABLE IF NOT EXISTS canary_budget (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL CHECK(status IN ('AVAILABLE','CLAIMED','APPROVAL_SUBMITTED','MINT_SUBMITTED','SUCCEEDED','FAILED','MANUALLY_RESET')),
  max_position_usd REAL NOT NULL,
  max_approval_usd REAL NOT NULL,
  max_attempts INTEGER NOT NULL CHECK(max_attempts = 1),
  attempts_used INTEGER NOT NULL DEFAULT 0 CHECK(attempts_used BETWEEN 0 AND 1),
  intent_id TEXT,
  failure_reason TEXT,
  remaining_allowance_raw TEXT,
  reset_token_hash TEXT,
  reset_expires_at TEXT,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO canary_budget(
  id,status,max_position_usd,max_approval_usd,max_attempts,attempts_used,updated_at
) VALUES(1,'AVAILABLE',5,5,1,0,datetime('now'));

CREATE TABLE IF NOT EXISTS canary_pool_selections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  pool_address TEXT NOT NULL,
  factory_address TEXT NOT NULL,
  token0_address TEXT NOT NULL,
  token1_address TEXT NOT NULL,
  fee INTEGER NOT NULL,
  tick_spacing INTEGER NOT NULL,
  discovery_block TEXT NOT NULL,
  liquidity_raw TEXT NOT NULL,
  tvl_usd REAL,
  initialized INTEGER NOT NULL,
  superseded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS canary_pool_selection_scope
  ON canary_pool_selections(user_id,chat_id,session_id,created_at);
CREATE INDEX IF NOT EXISTS canary_pool_selection_pool
  ON canary_pool_selections(pool_address,fee);
