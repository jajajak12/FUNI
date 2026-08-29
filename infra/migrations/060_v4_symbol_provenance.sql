-- Presentation-only, address-bound provenance. Economic identity remains unchanged.
ALTER TABLE v4_pool_selections ADD COLUMN target_symbol TEXT;
ALTER TABLE v4_pool_selections ADD COLUMN funding_symbol TEXT;
ALTER TABLE v4_pool_selections ADD COLUMN symbol_provenance_json TEXT;
ALTER TABLE v4_bid_ladders ADD COLUMN target_symbol TEXT;
ALTER TABLE v4_bid_ladders ADD COLUMN funding_symbol TEXT;
ALTER TABLE v4_bid_ladders ADD COLUMN symbol_provenance_json TEXT;
ALTER TABLE v4_positions ADD COLUMN symbol_provenance_json TEXT;
