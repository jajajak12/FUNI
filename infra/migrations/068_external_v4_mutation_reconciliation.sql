ALTER TABLE v4_bid_ladders
ADD COLUMN terminal_provenance TEXT
CHECK (
  terminal_provenance IS NULL OR
  terminal_provenance IN ('FUNI_AUTHORED_CLOSE_BATCH','EXTERNAL_ONCHAIN_MUTATION')
);

UPDATE v4_bid_ladders
SET terminal_provenance = CASE close_provenance
  WHEN 'FUNI_EXECUTED' THEN 'FUNI_AUTHORED_CLOSE_BATCH'
  WHEN 'EXTERNAL_OPERATOR_CLOSE' THEN 'EXTERNAL_ONCHAIN_MUTATION'
  WHEN 'UNKNOWN_EXTERNAL' THEN 'EXTERNAL_ONCHAIN_MUTATION'
END
WHERE status='CLOSED' AND terminal_provenance IS NULL;

CREATE TABLE v4_external_close_settlements (
  ladder_id TEXT PRIMARY KEY
    REFERENCES v4_bid_ladders(ladder_id) ON DELETE RESTRICT,
  chain_id INTEGER NOT NULL CHECK(chain_id=4663),
  provenance TEXT NOT NULL CHECK(provenance='EXTERNAL_ONCHAIN_MUTATION'),
  accounting_completeness TEXT NOT NULL
    CHECK(accounting_completeness IN ('FULL','PARTIAL','INCOMPLETE')),
  aggregate_token0_raw TEXT
    CHECK(aggregate_token0_raw IS NULL OR aggregate_token0_raw NOT GLOB '*[^0-9]*'),
  aggregate_token1_raw TEXT
    CHECK(aggregate_token1_raw IS NULL OR aggregate_token1_raw NOT GLOB '*[^0-9]*'),
  aggregate_gas_native_raw TEXT
    CHECK(aggregate_gas_native_raw IS NULL OR aggregate_gas_native_raw NOT GLOB '*[^0-9]*'),
  principal0_raw TEXT
    CHECK(principal0_raw IS NULL OR principal0_raw NOT GLOB '*[^0-9]*'),
  principal1_raw TEXT
    CHECK(principal1_raw IS NULL OR principal1_raw NOT GLOB '*[^0-9]*'),
  fee0_raw TEXT
    CHECK(fee0_raw IS NULL OR fee0_raw NOT GLOB '*[^0-9]*'),
  fee1_raw TEXT
    CHECK(fee1_raw IS NULL OR fee1_raw NOT GLOB '*[^0-9]*'),
  return_usd_micros TEXT
    CHECK(return_usd_micros IS NULL OR return_usd_micros NOT GLOB '*[^0-9]*'),
  first_close_block TEXT
    CHECK(first_close_block IS NULL OR first_close_block NOT GLOB '*[^0-9]*'),
  last_close_block TEXT
    CHECK(last_close_block IS NULL OR last_close_block NOT GLOB '*[^0-9]*'),
  observed_through_block TEXT NOT NULL
    CHECK(observed_through_block NOT GLOB '*[^0-9]*'),
  follow_on_swap_status TEXT NOT NULL CHECK(follow_on_swap_status IN (
    'PROVEN_NONE','ATTRIBUTED','UNATTRIBUTED_OR_AMBIGUOUS'
  )),
  reason_codes_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  evidence_fingerprint TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE v4_external_close_transactions (
  ladder_id TEXT NOT NULL
    REFERENCES v4_external_close_settlements(ladder_id) ON DELETE RESTRICT,
  transaction_hash TEXT NOT NULL COLLATE NOCASE,
  evidence_kind TEXT NOT NULL CHECK(evidence_kind IN (
    'EXTERNAL_V4_DECREASE_TAKE_PAIR','EXTERNAL_FOLLOW_ON_SWAP'
  )),
  leg_index INTEGER NOT NULL,
  token_id TEXT,
  block_number TEXT NOT NULL CHECK(block_number NOT GLOB '*[^0-9]*'),
  block_hash TEXT NOT NULL COLLATE NOCASE,
  transaction_index INTEGER,
  nonce INTEGER NOT NULL CHECK(nonce>=0),
  sender TEXT NOT NULL COLLATE NOCASE,
  target TEXT NOT NULL COLLATE NOCASE,
  token0_raw TEXT NOT NULL CHECK(token0_raw NOT GLOB '*[^0-9]*'),
  token1_raw TEXT NOT NULL CHECK(token1_raw NOT GLOB '*[^0-9]*'),
  gas_native_raw TEXT NOT NULL CHECK(gas_native_raw NOT GLOB '*[^0-9]*'),
  liquidity_removed_raw TEXT,
  nft_terminal_state TEXT CHECK(nft_terminal_state IN ('OWNED_ZERO','BURNED_ZERO')),
  valuation_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(ladder_id,transaction_hash,evidence_kind,leg_index),
  UNIQUE(ladder_id,evidence_kind,token_id)
);

CREATE INDEX v4_external_close_settlement_completeness_idx
ON v4_external_close_settlements(accounting_completeness,updated_at_ms);
