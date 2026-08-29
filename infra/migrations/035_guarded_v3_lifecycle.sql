-- Durable guarded v3 workflow evidence. This migration only extends the
-- chain-scoped tables introduced by migration 034; FUNI legacy tables and
-- historical receipt evidence are unchanged.
ALTER TABLE chain_callback_authorizations ADD COLUMN deployment_version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE chain_v3_workflows (
  chain_id INTEGER NOT NULL,
  protocol TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  action TEXT NOT NULL,
  state TEXT NOT NULL,
  position_identifier TEXT,
  replacement_position_identifier TEXT,
  deployment_version INTEGER NOT NULL,
  wallet_address TEXT NOT NULL COLLATE NOCASE,
  funding_token TEXT COLLATE NOCASE,
  preview_revision INTEGER NOT NULL,
  authorization_revision INTEGER,
  capability_snapshot_json TEXT NOT NULL,
  safety_evidence_json TEXT NOT NULL,
  exposure_evidence_json TEXT NOT NULL,
  fee_evidence_json TEXT NOT NULL,
  preview_json TEXT NOT NULL,
  commitment_usd REAL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(chain_id,protocol,workflow_id),
  UNIQUE(chain_id,protocol,idempotency_key)
);
CREATE UNIQUE INDEX chain_v3_one_active_workflow_per_position
ON chain_v3_workflows(chain_id,protocol,position_identifier)
WHERE position_identifier IS NOT NULL
  AND state NOT IN ('COMPLETED','CANCELLED','ABANDONED','FAILED_PERMANENT');

CREATE TABLE chain_v3_lifecycle_events (
  chain_id INTEGER NOT NULL,
  protocol TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  semantic_stage TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  journal_id TEXT,
  expected_hash TEXT COLLATE NOCASE,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(chain_id,protocol,workflow_id,semantic_stage,event_kind),
  FOREIGN KEY(chain_id,protocol,workflow_id)
    REFERENCES chain_v3_workflows(chain_id,protocol,workflow_id)
);

CREATE TABLE chain_accounting_events (
  chain_id INTEGER NOT NULL,
  protocol TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  semantic_stage TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  position_identifier TEXT,
  token_address TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  amount_raw TEXT,
  usd_value REAL,
  valuation_status TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(chain_id,protocol,workflow_id,semantic_stage,event_kind,token_address)
);
