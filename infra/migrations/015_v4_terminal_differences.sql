CREATE TABLE IF NOT EXISTS v4_terminal_differences (
  id TEXT PRIMARY KEY,
  position_id TEXT NOT NULL REFERENCES positions(id),
  token_index INTEGER NOT NULL CHECK(token_index IN (0,1)),
  token_address TEXT NOT NULL,
  amount_raw TEXT NOT NULL,
  reason TEXT NOT NULL,
  source_intent_id TEXT NOT NULL REFERENCES v4_lifecycle_intents(id),
  source_tx_hash TEXT NOT NULL REFERENCES v4_lifecycle_receipts(tx_hash),
  created_at TEXT NOT NULL,
  UNIQUE(position_id,token_index,reason)
);
CREATE INDEX IF NOT EXISTS idx_v4_terminal_difference_position ON v4_terminal_differences(position_id);
