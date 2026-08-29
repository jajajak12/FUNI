-- TVL is a separately sourced, time-bounded valuation.  In particular, it is
-- never derived from StateView active liquidity.
ALTER TABLE v4_pool_registry ADD COLUMN tvl_usd REAL;
ALTER TABLE v4_pool_registry ADD COLUMN tvl_source TEXT;
ALTER TABLE v4_pool_registry ADD COLUMN tvl_observed_at_ms INTEGER;
ALTER TABLE v4_pool_registry ADD COLUMN tvl_fresh_until_ms INTEGER;
ALTER TABLE v4_pool_registry ADD COLUMN tvl_status TEXT NOT NULL DEFAULT 'missing';

ALTER TABLE v3_pool_state_cache ADD COLUMN tvl_source TEXT;
ALTER TABLE v3_pool_state_cache ADD COLUMN tvl_observed_at_ms INTEGER;
ALTER TABLE v3_pool_state_cache ADD COLUMN tvl_fresh_until_ms INTEGER;
ALTER TABLE v3_pool_state_cache ADD COLUMN tvl_status TEXT NOT NULL DEFAULT 'missing';

ALTER TABLE canary_pool_selections ADD COLUMN tvl_source TEXT;
ALTER TABLE canary_pool_selections ADD COLUMN tvl_observed_at_ms INTEGER;
ALTER TABLE canary_pool_selections ADD COLUMN tvl_fresh_until_ms INTEGER;
ALTER TABLE canary_pool_selections ADD COLUMN tvl_status TEXT NOT NULL DEFAULT 'missing';

CREATE INDEX IF NOT EXISTS idx_v4_registry_strict_tvl ON v4_pool_registry(tvl_status,tvl_fresh_until_ms,tvl_usd);
CREATE INDEX IF NOT EXISTS idx_v3_cache_strict_tvl ON v3_pool_state_cache(tvl_status,tvl_fresh_until_ms,tvl_usd);
