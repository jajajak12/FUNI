-- migrate: foreign_keys=off

ALTER TABLE v4_bid_ladder_legs RENAME TO v4_bid_ladder_legs_054_old;
ALTER TABLE v4_bid_ladders RENAME TO v4_bid_ladders_054_old;

CREATE TABLE v4_bid_ladders (
  ladder_id TEXT PRIMARY KEY CHECK(length(ladder_id) > 0),
  strategy_version TEXT NOT NULL CHECK(strategy_version = 'V4_BID_LADDER_V1'),
  execution_mode TEXT NOT NULL CHECK(execution_mode IN ('DRY_RUN','LIVE')),
  pool_id TEXT NOT NULL CHECK(length(pool_id) = 66 AND substr(pool_id,1,2) = '0x'),
  currency0 TEXT NOT NULL CHECK(length(currency0) = 42 AND substr(currency0,1,2) = '0x'),
  currency1 TEXT NOT NULL CHECK(length(currency1) = 42 AND substr(currency1,1,2) = '0x' AND lower(currency0) <> lower(currency1)),
  fee INTEGER NOT NULL CHECK(fee >= 0 AND fee <= 16777215),
  tick_spacing INTEGER NOT NULL CHECK(tick_spacing > 0),
  hooks TEXT NOT NULL CHECK(length(hooks) = 42 AND substr(hooks,1,2) = '0x'),
  funding_token TEXT NOT NULL CHECK(length(funding_token) = 42 AND substr(funding_token,1,2) = '0x'),
  target_token TEXT NOT NULL CHECK(length(target_token) = 42 AND substr(target_token,1,2) = '0x' AND lower(funding_token) <> lower(target_token)),
  funding_index INTEGER NOT NULL CHECK(funding_index IN (0,1)),
  target_index INTEGER NOT NULL CHECK(target_index IN (0,1) AND target_index <> funding_index),
  reference_tick INTEGER NOT NULL,
  reference_block TEXT NOT NULL CHECK(length(reference_block) > 0 AND reference_block NOT GLOB '*[^0-9]*'),
  reference_block_hash TEXT CHECK(reference_block_hash IS NULL OR (length(reference_block_hash) = 66 AND substr(reference_block_hash,1,2) = '0x')),
  total_funding_amount_raw TEXT NOT NULL CHECK(length(total_funding_amount_raw) > 0 AND total_funding_amount_raw NOT GLOB '*[^0-9]*'),
  entry_usd_snapshot REAL CHECK(entry_usd_snapshot IS NULL OR entry_usd_snapshot >= 0),
  status TEXT NOT NULL CHECK(status IN ('PLANNED','OPEN','CLOSED','CANCELLED')),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
  terminal_reason TEXT,
  terminal_at_ms INTEGER CHECK(terminal_at_ms IS NULL OR terminal_at_ms >= created_at_ms),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  CHECK(
    (status = 'CANCELLED' AND terminal_reason IS NOT NULL AND terminal_at_ms IS NOT NULL) OR
    (status <> 'CANCELLED' AND terminal_reason IS NULL AND terminal_at_ms IS NULL)
  )
);

CREATE TABLE v4_bid_ladder_legs (
  ladder_id TEXT NOT NULL,
  leg_index INTEGER NOT NULL CHECK(leg_index BETWEEN 0 AND 4),
  upper_drop_bps INTEGER NOT NULL CHECK(upper_drop_bps > 0 AND upper_drop_bps < 10000),
  lower_drop_bps INTEGER NOT NULL CHECK(lower_drop_bps > upper_drop_bps AND lower_drop_bps < 10000),
  capital_weight_bps INTEGER NOT NULL CHECK(capital_weight_bps > 0),
  tick_lower INTEGER NOT NULL,
  tick_upper INTEGER NOT NULL CHECK(tick_lower < tick_upper),
  funding_amount_raw TEXT NOT NULL CHECK(length(funding_amount_raw) > 0 AND funding_amount_raw NOT GLOB '*[^0-9]*'),
  planned_liquidity_raw TEXT NOT NULL CHECK(length(planned_liquidity_raw) > 0 AND planned_liquidity_raw NOT GLOB '*[^0-9]*'),
  funding_index INTEGER NOT NULL CHECK(funding_index IN (0,1)),
  target_index INTEGER NOT NULL CHECK(target_index IN (0,1) AND target_index <> funding_index),
  status TEXT NOT NULL CHECK(status IN ('PLANNED','OPEN','CLOSED','CANCELLED')),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
  token_id TEXT CHECK(token_id IS NULL OR (length(token_id) > 0 AND token_id NOT GLOB '*[^0-9]*')),
  open_batch_id TEXT,
  close_batch_id TEXT,
  PRIMARY KEY(ladder_id, leg_index),
  UNIQUE(ladder_id, tick_lower, tick_upper),
  FOREIGN KEY(ladder_id) REFERENCES v4_bid_ladders(ladder_id) ON DELETE RESTRICT,
  CHECK(
    (leg_index = 0 AND capital_weight_bps = 800) OR
    (leg_index = 1 AND capital_weight_bps = 1200) OR
    (leg_index = 2 AND capital_weight_bps = 1800) OR
    (leg_index = 3 AND capital_weight_bps = 2500) OR
    (leg_index = 4 AND capital_weight_bps = 3700)
  )
);

INSERT INTO v4_bid_ladders (
  ladder_id,strategy_version,execution_mode,pool_id,currency0,currency1,fee,
  tick_spacing,hooks,funding_token,target_token,funding_index,target_index,
  reference_tick,reference_block,reference_block_hash,total_funding_amount_raw,
  entry_usd_snapshot,status,created_at_ms,updated_at_ms,
  terminal_reason,terminal_at_ms,revision
)
SELECT
  ladder_id,strategy_version,execution_mode,pool_id,currency0,currency1,fee,
  tick_spacing,hooks,funding_token,target_token,funding_index,target_index,
  reference_tick,reference_block,reference_block_hash,total_funding_amount_raw,
  entry_usd_snapshot,status,created_at_ms,updated_at_ms,
  NULL,NULL,0
FROM v4_bid_ladders_054_old;

INSERT INTO v4_bid_ladder_legs (
  ladder_id,leg_index,upper_drop_bps,lower_drop_bps,capital_weight_bps,
  tick_lower,tick_upper,funding_amount_raw,planned_liquidity_raw,funding_index,
  target_index,status,created_at_ms,updated_at_ms,token_id,open_batch_id,
  close_batch_id
)
SELECT
  ladder_id,leg_index,upper_drop_bps,lower_drop_bps,capital_weight_bps,
  tick_lower,tick_upper,funding_amount_raw,planned_liquidity_raw,funding_index,
  target_index,status,created_at_ms,updated_at_ms,token_id,open_batch_id,
  close_batch_id
FROM v4_bid_ladder_legs_054_old;

DROP TABLE v4_bid_ladder_legs_054_old;
DROP TABLE v4_bid_ladders_054_old;
