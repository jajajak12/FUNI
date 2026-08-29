-- Chain-bound guarded-live callback evidence. Defaults preserve existing
-- authorizations while new BSC/Ethereum flows bind every mutable revision.
ALTER TABLE chain_callback_authorizations ADD COLUMN wallet_address TEXT NOT NULL DEFAULT '' COLLATE NOCASE;
ALTER TABLE chain_callback_authorizations ADD COLUMN exposure_revision TEXT NOT NULL DEFAULT '';
ALTER TABLE chain_callback_authorizations ADD COLUMN fee_evidence_revision TEXT NOT NULL DEFAULT '';

