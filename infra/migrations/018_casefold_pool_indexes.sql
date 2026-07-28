CREATE INDEX IF NOT EXISTS idx_v4_registry_currency0_lower ON v4_pool_registry(lower(currency0));
CREATE INDEX IF NOT EXISTS idx_v4_registry_currency1_lower ON v4_pool_registry(lower(currency1));
CREATE INDEX IF NOT EXISTS idx_v3_cache_token0_lower ON v3_pool_state_cache(lower(token0_address));
CREATE INDEX IF NOT EXISTS idx_v3_cache_token1_lower ON v3_pool_state_cache(lower(token1_address));
