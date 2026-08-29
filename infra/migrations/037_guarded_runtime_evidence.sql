-- Canonical, chain/protocol-scoped read-only evidence used by every guarded-v3
-- status, preview and executor gate.  This table never stores transaction
-- calldata, serialized transactions, nonces reserved for execution, or signer
-- material.
CREATE TABLE chain_runtime_evidence (
  chain_id INTEGER NOT NULL,
  protocol TEXT NOT NULL,
  evidence_kind TEXT NOT NULL,
  evidence_revision TEXT NOT NULL,
  deployment_version INTEGER NOT NULL,
  provider_set_revision TEXT NOT NULL,
  observed_block TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  valid_until_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY(chain_id,protocol,evidence_kind)
);

CREATE INDEX chain_runtime_evidence_validity_idx
ON chain_runtime_evidence(chain_id,protocol,evidence_kind,valid_until_ms);
