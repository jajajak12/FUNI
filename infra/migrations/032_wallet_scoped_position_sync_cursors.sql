-- Preserve protocol-only cursor history for audit.  It cannot safely be
-- attributed to a wallet after a wallet rotation.
ALTER TABLE wallet_position_sync_cursors RENAME TO wallet_position_sync_cursors_legacy;

CREATE TABLE wallet_position_sync_cursors (
  protocol_version TEXT NOT NULL CHECK (protocol_version IN ('v3','v4')),
  wallet_address TEXT NOT NULL,
  manager_address TEXT NOT NULL,
  initialized_from_block TEXT NOT NULL,
  next_block TEXT NOT NULL,
  latest_observed_block TEXT NOT NULL,
  window_size INTEGER NOT NULL CHECK (window_size > 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (protocol_version, wallet_address)
);
