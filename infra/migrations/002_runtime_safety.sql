-- Durable, single-operator runtime state. No private material is stored here.
CREATE TABLE IF NOT EXISTS operator_safety_state (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS confirmation_requests (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('DRAFT','SIMULATED','AWAITING_CONFIRMATION','EXPIRED','CANCELLED','EXECUTION_BLOCKED','SUBMITTED','CONFIRMED','REVERTED','RECONCILED')),
  owner TEXT NOT NULL,
  block_number TEXT,
  price_observed_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS confirmation_requests_state_expiry ON confirmation_requests(state, expires_at);
