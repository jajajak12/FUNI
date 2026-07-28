CREATE TABLE IF NOT EXISTS gmgn_robinhood_alert_deliveries (
  token_address TEXT NOT NULL COLLATE NOCASE,
  admission_snapshot_hash TEXT NOT NULL,
  destination_type TEXT NOT NULL CHECK(destination_type IN ('private','group')),
  status TEXT NOT NULL CHECK(status IN ('SENT','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  delivered_at_ms INTEGER,
  last_attempt_at_ms INTEGER NOT NULL,
  PRIMARY KEY(token_address, admission_snapshot_hash, destination_type)
);
