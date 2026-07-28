ALTER TABLE rebalance_workflows ADD COLUMN execution_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE rebalance_workflows ADD COLUMN projected_gas_usd REAL;
ALTER TABLE rebalance_workflows ADD COLUMN actual_gas_usd REAL NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS rebalance_transactions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES rebalance_workflows(id),
  semantic_stage TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK(attempt>=0),
  status TEXT NOT NULL CHECK(status IN ('PREPARED','SUBMITTED','CONFIRMED','FAILED')),
  tx_hash TEXT NOT NULL UNIQUE,
  nonce INTEGER NOT NULL,
  to_address TEXT NOT NULL,
  calldata_hash TEXT NOT NULL,
  request_json TEXT NOT NULL,
  estimated_gas_raw TEXT NOT NULL,
  estimated_gas_usd REAL NOT NULL,
  actual_gas_raw TEXT,
  actual_gas_usd REAL,
  receipt_json TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  submitted_at TEXT,
  confirmed_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(workflow_id,semantic_stage,attempt)
);

CREATE INDEX IF NOT EXISTS idx_rebalance_transactions_workflow
  ON rebalance_transactions(workflow_id,semantic_stage,status);
