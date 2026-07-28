CREATE TABLE IF NOT EXISTS canary_arms (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('PENDING','ARMED','CONSUMED','DISARMED','EXPIRED')),
  expires_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_canary_arm_per_operator ON canary_arms(user_id,chat_id) WHERE status='ARMED';
CREATE TABLE IF NOT EXISTS canary_execution_intents (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  owner TEXT NOT NULL,
  state TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  approval_hash TEXT,
  mint_hash TEXT,
  token_id TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS canary_execution_wallet_state ON canary_execution_intents(wallet,state);
