-- Canonical interactive-flow storage: all timestamps are Unix epoch milliseconds.
CREATE TABLE IF NOT EXISTS telegram_flow_sessions (
  scope TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  state_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','expired','cancelled')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS telegram_flow_sessions_expiry ON telegram_flow_sessions(status, expires_at_ms);
