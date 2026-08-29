-- Durable post-receipt work only. Transaction journals and execution intents
-- remain the sole signing, broadcast, nonce, hash, and receipt authorities.
CREATE TABLE economic_reconciliation_work (
  work_id TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  protocol TEXT NOT NULL,
  workflow_kind TEXT NOT NULL CHECK(workflow_kind IN (
    'V4_BID_LADDER_OPEN','V4_OPERATIONAL_OPEN','V4_BID_LADDER_CLOSE',
    'V4_GENERIC_CLOSE','V4_BID_LADDER_CLAIM','V4_GENERIC_CLAIM'
  )),
  workflow_identity TEXT NOT NULL,
  semantic_stage TEXT NOT NULL,
  transaction_hash TEXT NOT NULL COLLATE NOCASE,
  source_table TEXT NOT NULL CHECK(source_table IN (
    'chain_transaction_journal','v4_live_open_intents','v4_lifecycle_intents'
  )),
  source_identity TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'PENDING','LEASED','RETRYABLE','COMPLETED','FAILED_CLOSED'
  )),
  priority INTEGER NOT NULL DEFAULT 100,
  available_at_ms INTEGER NOT NULL,
  leased_until_ms INTEGER,
  lease_owner TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  sanitized_error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  CHECK(transaction_hash=lower(transaction_hash)),
  UNIQUE(chain_id,workflow_kind,workflow_identity,semantic_stage,transaction_hash),
  UNIQUE(chain_id,source_table,source_identity,semantic_stage,transaction_hash)
);

CREATE INDEX economic_reconciliation_work_due_idx
  ON economic_reconciliation_work(status,priority DESC,available_at_ms,leased_until_ms);
