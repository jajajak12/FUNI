CREATE TABLE IF NOT EXISTS rebalance_lineages (
  id TEXT PRIMARY KEY,
  root_position_id TEXT NOT NULL UNIQUE,
  original_principal_usd REAL NOT NULL CHECK(original_principal_usd>0),
  original_funding_token TEXT NOT NULL,
  original_funding_symbol TEXT NOT NULL,
  protocol_version TEXT NOT NULL CHECK(protocol_version IN ('v3','v4')),
  pool_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rebalance_workflows (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  lineage_id TEXT NOT NULL REFERENCES rebalance_lineages(id),
  old_position_id TEXT NOT NULL,
  replacement_position_id TEXT,
  mode TEXT NOT NULL CHECK(mode IN ('REBALANCE','REBALANCE_COMPOUND')),
  downside_pct REAL NOT NULL CHECK(downside_pct>0 AND downside_pct<100),
  state TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  approved_topup_usd REAL,
  preview_json TEXT NOT NULL,
  state_json TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rebalance_active_position
  ON rebalance_workflows(old_position_id)
  WHERE state NOT IN ('COMPLETED','FAILED_TERMINAL','CANCELLED');

CREATE TABLE IF NOT EXISTS rebalance_transitions (
  workflow_id TEXT NOT NULL REFERENCES rebalance_workflows(id),
  ordinal INTEGER NOT NULL,
  state TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(workflow_id,ordinal)
);

CREATE TABLE IF NOT EXISTS rebalance_receipts (
  workflow_id TEXT NOT NULL REFERENCES rebalance_workflows(id),
  stage TEXT NOT NULL,
  tx_hash TEXT NOT NULL UNIQUE,
  receipt_json TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  PRIMARY KEY(workflow_id,stage)
);

CREATE TABLE IF NOT EXISTS rebalance_accounting_events (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES rebalance_workflows(id),
  kind TEXT NOT NULL,
  token_address TEXT,
  amount_raw TEXT,
  usd_value REAL,
  price_source TEXT,
  price_block TEXT,
  observed_at TEXT NOT NULL,
  provenance_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rebalance_accounting_workflow
  ON rebalance_accounting_events(workflow_id,kind);
