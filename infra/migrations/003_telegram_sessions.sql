CREATE TABLE IF NOT EXISTS telegram_sessions (
  owner TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
