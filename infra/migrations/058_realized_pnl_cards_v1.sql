-- Immutable, append-only economic finality ledger.  Rows are written only
-- after exact receipt reconciliation and never use mutable lifecycle dates.
CREATE TABLE realized_pnl_events (
  event_id TEXT PRIMARY KEY,
  event_kind TEXT NOT NULL CHECK(event_kind IN ('CLAIM','CLOSE')),
  protocol TEXT NOT NULL,
  strategy_type TEXT,
  position_identity TEXT,
  ladder_identity TEXT,
  workflow_identity TEXT NOT NULL,
  journal_stage TEXT NOT NULL,
  transaction_hash TEXT NOT NULL COLLATE NOCASE,
  block_number TEXT NOT NULL,
  block_hash TEXT COLLATE NOCASE,
  economic_final_at_ms INTEGER NOT NULL CHECK(economic_final_at_ms >= 0),
  economic_final_source TEXT NOT NULL CHECK(economic_final_source = 'RECEIPT_BLOCK_TIMESTAMP'),
  capital_basis_usd TEXT,
  returned_principal_usd TEXT,
  newly_realized_fees_usd TEXT,
  realized_pnl_usd TEXT,
  token0_raw TEXT,
  token1_raw TEXT,
  token0_decimals INTEGER,
  token1_decimals INTEGER,
  valuation_status TEXT NOT NULL CHECK(valuation_status IN ('AVAILABLE','INCOMPLETE')),
  valuation_evidence_json TEXT NOT NULL,
  close_reason TEXT,
  presentation_metadata_json TEXT,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(workflow_identity,journal_stage,transaction_hash,event_kind)
);
CREATE INDEX realized_pnl_events_day_idx ON realized_pnl_events(economic_final_at_ms,event_kind);

-- Exact fixed-point USD basis history for generic V4 NFTs. USD values are
-- integer micro-dollars encoded as decimal TEXT; no REAL arithmetic is used.
-- The current executable surface has no V4 increase action, but ADD remains
-- reserved so future support cannot bypass the same ordered contract.
CREATE TABLE v4_position_basis_events (
  basis_event_id TEXT PRIMARY KEY,
  position_identity TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK(event_kind IN ('INITIAL','ADD','CONSUME')),
  workflow_identity TEXT NOT NULL,
  journal_stage TEXT NOT NULL,
  transaction_hash TEXT NOT NULL COLLATE NOCASE,
  block_number TEXT NOT NULL CHECK(block_number NOT GLOB '*[^0-9]*'),
  transaction_index INTEGER,
  liquidity_before_raw TEXT,
  liquidity_delta_raw TEXT NOT NULL CHECK(liquidity_delta_raw NOT GLOB '*[^0-9]*'),
  liquidity_after_raw TEXT NOT NULL CHECK(liquidity_after_raw NOT GLOB '*[^0-9]*'),
  basis_before_usd_micros TEXT NOT NULL CHECK(basis_before_usd_micros NOT GLOB '*[^0-9]*'),
  basis_delta_usd_micros TEXT NOT NULL CHECK(basis_delta_usd_micros NOT GLOB '*[^0-9]*'),
  basis_after_usd_micros TEXT NOT NULL CHECK(basis_after_usd_micros NOT GLOB '*[^0-9]*'),
  evidence_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(position_identity,workflow_identity,journal_stage,transaction_hash,event_kind)
);
CREATE INDEX v4_position_basis_order_idx ON v4_position_basis_events(position_identity,block_number,transaction_index,basis_event_id);

-- Telegram transport is deliberately separate from economic truth.  An
-- uncertain transport outcome is terminal for automatic close cards.
CREATE TABLE pnl_card_deliveries (
  delivery_id TEXT PRIMARY KEY,
  card_kind TEXT NOT NULL CHECK(card_kind IN ('CLOSE','DAILY')),
  economic_event_id TEXT REFERENCES realized_pnl_events(event_id),
  requested_day_wib TEXT,
  chat_identity TEXT NOT NULL,
  render_status TEXT NOT NULL CHECK(render_status IN ('PENDING','RENDERED','FALLBACK_TEXT','FAILED')),
  delivery_status TEXT NOT NULL CHECK(delivery_status IN ('PENDING','SENDING','DELIVERED','FAILED','DELIVERY_UNCERTAIN')),
  telegram_message_id TEXT,
  attempted_at_ms INTEGER,
  delivered_at_ms INTEGER,
  error_code TEXT,
  metadata_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK((card_kind='CLOSE') = (economic_event_id IS NOT NULL)),
  CHECK((card_kind='DAILY') = (requested_day_wib IS NOT NULL))
);
CREATE UNIQUE INDEX pnl_card_close_delivery_once ON pnl_card_deliveries(card_kind,economic_event_id,chat_identity) WHERE card_kind='CLOSE';
CREATE UNIQUE INDEX pnl_card_daily_delivery_once ON pnl_card_deliveries(card_kind,requested_day_wib,chat_identity) WHERE card_kind='DAILY';

CREATE TABLE realized_pnl_coverage (
  coverage_key TEXT PRIMARY KEY CHECK(coverage_key='v1'),
  started_at_ms INTEGER NOT NULL,
  source TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
