-- Durable, per-child-generation JIT rematerialization budget.
-- Revision remains state/CAS authority and is deliberately independent.
ALTER TABLE v4_bid_ladder_usdg_reset_v1
ADD COLUMN jit_rematerialization_attempts INTEGER NOT NULL DEFAULT 0
CHECK(jit_rematerialization_attempts BETWEEN 0 AND 3);

ALTER TABLE v4_bid_ladder_usdg_reset_v1
ADD COLUMN jit_last_failure_code TEXT;

ALTER TABLE v4_bid_ladder_usdg_reset_v1
ADD COLUMN jit_last_reference_tick INTEGER;

ALTER TABLE v4_bid_ladder_usdg_reset_v1
ADD COLUMN jit_last_reference_block TEXT
CHECK(jit_last_reference_block IS NULL OR
      (length(jit_last_reference_block) > 0 AND jit_last_reference_block NOT GLOB '*[^0-9]*'));

ALTER TABLE v4_bid_ladder_usdg_reset_v1
ADD COLUMN jit_last_attempt_at_ms INTEGER
CHECK(jit_last_attempt_at_ms IS NULL OR jit_last_attempt_at_ms >= 0);
