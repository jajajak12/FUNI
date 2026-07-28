CREATE TABLE IF NOT EXISTS rebalance_commitment_releases (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL UNIQUE REFERENCES rebalance_workflows(id),
  release_kind TEXT NOT NULL CHECK(release_kind='PERMANENT_OPERATOR_ABANDONMENT'),
  old_position_id TEXT NOT NULL,
  lineage_id TEXT NOT NULL,
  source_wallet_address TEXT NOT NULL,
  workflow_state_at_release TEXT NOT NULL,
  workflow_revision_at_release INTEGER NOT NULL,
  released_commitment_usd REAL NOT NULL CHECK(released_commitment_usd>=0),
  evidence_fingerprint TEXT NOT NULL,
  operator_actor TEXT NOT NULL,
  operator_reason TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
