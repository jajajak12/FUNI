ALTER TABLE v4_bid_ladder_legs ADD COLUMN token_id TEXT CHECK(token_id IS NULL OR (length(token_id) > 0 AND token_id NOT GLOB '*[^0-9]*'));
ALTER TABLE v4_bid_ladder_legs ADD COLUMN open_batch_id TEXT;
ALTER TABLE v4_bid_ladder_legs ADD COLUMN close_batch_id TEXT;
