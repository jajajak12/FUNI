-- Forward-only multi-chain identity. Existing FUNI evidence is never rewritten;
-- every legacy row is explicitly scoped to chain 4663 and its proven protocol.
ALTER TABLE positions ADD COLUMN chain_id INTEGER NOT NULL DEFAULT 4663;
ALTER TABLE positions ADD COLUMN protocol TEXT NOT NULL DEFAULT 'uniswap_v3';
CREATE INDEX positions_chain_protocol_token_idx ON positions(chain_id,protocol,token_id);

ALTER TABLE v4_positions ADD COLUMN chain_id INTEGER NOT NULL DEFAULT 4663;
ALTER TABLE v4_positions ADD COLUMN protocol TEXT NOT NULL DEFAULT 'uniswap_v4';
CREATE INDEX v4_positions_chain_protocol_token_idx ON v4_positions(chain_id,protocol,token_id);

ALTER TABLE v4_lifecycle_intents ADD COLUMN chain_id INTEGER NOT NULL DEFAULT 4663;
ALTER TABLE v4_lifecycle_intents ADD COLUMN protocol TEXT NOT NULL DEFAULT 'uniswap_v4';
ALTER TABLE v4_lifecycle_receipts ADD COLUMN chain_id INTEGER NOT NULL DEFAULT 4663;
ALTER TABLE v4_lifecycle_receipts ADD COLUMN protocol TEXT NOT NULL DEFAULT 'uniswap_v4';
ALTER TABLE v4_lifecycle_transitions ADD COLUMN chain_id INTEGER NOT NULL DEFAULT 4663;
ALTER TABLE v4_lifecycle_transitions ADD COLUMN protocol TEXT NOT NULL DEFAULT 'uniswap_v4';

ALTER TABLE transaction_intents ADD COLUMN chain_id INTEGER NOT NULL DEFAULT 4663;
ALTER TABLE transaction_intents ADD COLUMN protocol TEXT NOT NULL DEFAULT 'uniswap_v3';
ALTER TABLE transaction_receipts ADD COLUMN chain_id INTEGER NOT NULL DEFAULT 4663;
ALTER TABLE transaction_receipts ADD COLUMN protocol TEXT NOT NULL DEFAULT 'uniswap_v3';
ALTER TABLE gas_costs ADD COLUMN chain_id INTEGER NOT NULL DEFAULT 4663;
ALTER TABLE gas_costs ADD COLUMN native_symbol TEXT NOT NULL DEFAULT 'ETH';

ALTER TABLE wallet_position_candidates ADD COLUMN chain_id INTEGER NOT NULL DEFAULT 4663;
ALTER TABLE wallet_position_candidates ADD COLUMN protocol TEXT NOT NULL DEFAULT 'uniswap_v4';
ALTER TABLE position_adoptions ADD COLUMN chain_id INTEGER NOT NULL DEFAULT 4663;
ALTER TABLE position_adoptions ADD COLUMN protocol TEXT NOT NULL DEFAULT 'uniswap_v4';
ALTER TABLE active_position_reconciliations ADD COLUMN chain_id INTEGER NOT NULL DEFAULT 4663;
ALTER TABLE active_position_reconciliations ADD COLUMN protocol TEXT NOT NULL DEFAULT 'uniswap_v4';
ALTER TABLE targeted_position_reconciliation_requests ADD COLUMN chain_id INTEGER NOT NULL DEFAULT 4663;
ALTER TABLE targeted_position_reconciliation_requests ADD COLUMN protocol TEXT NOT NULL DEFAULT 'uniswap_v4';

ALTER TABLE token_metadata_cache ADD COLUMN chain_id INTEGER NOT NULL DEFAULT 4663;
ALTER TABLE v3_pool_state_cache ADD COLUMN chain_id INTEGER NOT NULL DEFAULT 4663;
ALTER TABLE v3_pool_state_cache ADD COLUMN protocol TEXT NOT NULL DEFAULT 'uniswap_v3';
ALTER TABLE portfolio_persisted_snapshot ADD COLUMN chain_id INTEGER NOT NULL DEFAULT 4663;

ALTER TABLE confirmation_requests ADD COLUMN chain_id INTEGER NOT NULL DEFAULT 4663;
ALTER TABLE confirmation_requests ADD COLUMN chain_key TEXT NOT NULL DEFAULT 'robinhood';
ALTER TABLE confirmation_requests ADD COLUMN protocol TEXT NOT NULL DEFAULT 'uniswap_v3';
ALTER TABLE confirmation_requests ADD COLUMN preview_revision INTEGER NOT NULL DEFAULT 0;

-- Canonical identities for all new multi-chain reads and writes. Legacy tables
-- remain available to FUNI compatibility wrappers without changing behavior.
CREATE TABLE chain_tokens (
  chain_id INTEGER NOT NULL,
  address TEXT NOT NULL COLLATE NOCASE,
  symbol TEXT NOT NULL,
  decimals INTEGER NOT NULL CHECK(decimals BETWEEN 0 AND 255),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  refreshed_at_ms INTEGER,
  PRIMARY KEY(chain_id,address)
);

CREATE TABLE chain_pools (
  chain_id INTEGER NOT NULL,
  protocol TEXT NOT NULL,
  pool_address TEXT NOT NULL COLLATE NOCASE,
  token0_address TEXT NOT NULL COLLATE NOCASE,
  token1_address TEXT NOT NULL COLLATE NOCASE,
  fee INTEGER,
  tick_spacing INTEGER,
  state_json TEXT NOT NULL DEFAULT '{}',
  validation_status TEXT NOT NULL DEFAULT 'DISCOVERED',
  blocker_reason TEXT,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(chain_id,protocol,pool_address)
);
CREATE INDEX chain_pools_tokens_idx ON chain_pools(chain_id,protocol,token0_address,token1_address);

CREATE TABLE chain_positions (
  chain_id INTEGER NOT NULL,
  protocol TEXT NOT NULL,
  position_identifier TEXT NOT NULL,
  legacy_position_id TEXT,
  owner_address TEXT,
  provenance TEXT NOT NULL CHECK(provenance IN ('BOT_OPERATIONAL','MANUAL_EXTERNAL')),
  lifecycle_state TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(chain_id,protocol,position_identifier)
);
INSERT INTO chain_positions(chain_id,protocol,position_identifier,legacy_position_id,provenance,lifecycle_state,payload_json,created_at,updated_at)
SELECT 4663,'uniswap_v3',token_id,id,'BOT_OPERATIONAL',status,'{}',created_at,created_at FROM positions;
INSERT OR IGNORE INTO chain_positions(chain_id,protocol,position_identifier,legacy_position_id,owner_address,provenance,lifecycle_state,payload_json,created_at,updated_at)
SELECT 4663,'uniswap_v4',token_id,'v4:'||token_id,owner,'BOT_OPERATIONAL',status,'{}',created_at,updated_at FROM v4_positions;
UPDATE chain_positions SET provenance='MANUAL_EXTERNAL'
WHERE legacy_position_id IN (SELECT position_id FROM position_adoptions WHERE source='MANUAL_EXTERNAL');

CREATE TABLE chain_registry_cursors (
  chain_id INTEGER NOT NULL,
  protocol TEXT NOT NULL,
  cursor_kind TEXT NOT NULL,
  next_block TEXT NOT NULL,
  finality_confirmations INTEGER NOT NULL,
  state_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY(chain_id,protocol,cursor_kind)
);

CREATE TABLE chain_nonce_mutex (
  chain_id INTEGER NOT NULL,
  wallet_address TEXT NOT NULL COLLATE NOCASE,
  nonce TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(chain_id,wallet_address)
);
INSERT INTO chain_nonce_mutex(chain_id,wallet_address,nonce,acquired_at,expires_at)
SELECT 4663,lower(wallet),nonce,acquired_at,expires_at FROM nonce_mutex;

CREATE TABLE chain_transaction_journal (
  chain_id INTEGER NOT NULL,
  chain_key TEXT NOT NULL,
  protocol TEXT NOT NULL,
  journal_id TEXT NOT NULL,
  wallet_address TEXT NOT NULL COLLATE NOCASE,
  workflow_identity TEXT NOT NULL,
  semantic_stage TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK(attempt>=0),
  status TEXT NOT NULL CHECK(status IN ('PREPARED','SUBMITTED','CONFIRMED','FAILED')),
  nonce INTEGER NOT NULL,
  transaction_type TEXT NOT NULL,
  expected_hash TEXT NOT NULL COLLATE NOCASE,
  to_address TEXT NOT NULL COLLATE NOCASE,
  request_fingerprint TEXT NOT NULL,
  fee_model TEXT NOT NULL CHECK(fee_model IN ('legacy','eip1559')),
  projected_gas_native TEXT,
  projected_gas_usd REAL,
  actual_gas_native TEXT,
  actual_gas_usd REAL,
  receipt_json TEXT,
  provider_evidence_json TEXT NOT NULL DEFAULT '{}',
  confirmation_count INTEGER NOT NULL DEFAULT 0,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  submitted_at TEXT,
  confirmed_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(chain_id,journal_id),
  UNIQUE(chain_id,expected_hash),
  UNIQUE(chain_id,workflow_identity,semantic_stage,attempt)
);
CREATE INDEX chain_transaction_wallet_nonce_idx ON chain_transaction_journal(chain_id,wallet_address,nonce);

CREATE TABLE chain_workflow_bindings (
  chain_id INTEGER NOT NULL,
  protocol TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  deployment_version INTEGER NOT NULL,
  position_identifier TEXT,
  wallet_address TEXT NOT NULL COLLATE NOCASE,
  preview_revision INTEGER NOT NULL,
  execution_authorization_revision INTEGER,
  capability_snapshot_json TEXT NOT NULL,
  safety_evidence_json TEXT NOT NULL,
  exposure_evidence_json TEXT NOT NULL,
  fee_evidence_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(chain_id,protocol,workflow_id)
);

CREATE TABLE chain_callback_authorizations (
  authorization_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  protocol TEXT NOT NULL,
  workflow_or_position_id TEXT NOT NULL,
  action TEXT NOT NULL,
  preview_revision INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  consumed_at_ms INTEGER,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE chain_exposure_commitments (
  chain_id INTEGER NOT NULL,
  protocol TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK(provenance IN ('BOT_OPERATIONAL','MANUAL_EXTERNAL')),
  committed_usd REAL,
  valuation_status TEXT NOT NULL,
  valuation_source TEXT,
  valuation_observed_at TEXT,
  released_at TEXT,
  evidence_json TEXT NOT NULL,
  PRIMARY KEY(chain_id,protocol,workflow_id)
);

CREATE TABLE chain_portfolio_snapshots (
  chain_id INTEGER NOT NULL,
  protocol TEXT NOT NULL,
  snapshot_key TEXT NOT NULL DEFAULT 'current',
  payload_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  valuation_status TEXT NOT NULL,
  valuation_source TEXT,
  valuation_observed_at TEXT,
  refreshed_at_ms INTEGER NOT NULL,
  PRIMARY KEY(chain_id,protocol,snapshot_key)
);
