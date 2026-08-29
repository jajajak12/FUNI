CREATE TABLE v4_operational_open_receipts (
  tx_hash TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES v4_live_open_intents(id),
  phase TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX v4_operational_open_receipts_intent_idx
  ON v4_operational_open_receipts(intent_id, created_at);
