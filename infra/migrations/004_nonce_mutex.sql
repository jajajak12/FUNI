CREATE TABLE IF NOT EXISTS nonce_mutex (
  wallet TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
