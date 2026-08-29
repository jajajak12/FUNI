CREATE TABLE IF NOT EXISTS v4_symbol_provenance_conflicts (
  token_id TEXT NOT NULL REFERENCES v4_positions(token_id),
  token_address TEXT NOT NULL,
  established_symbol TEXT NOT NULL,
  proposed_symbol TEXT NOT NULL,
  established_provenance_json TEXT,
  proposed_provenance_json TEXT,
  observed_at_ms INTEGER NOT NULL,
  PRIMARY KEY(token_id, proposed_symbol)
);
