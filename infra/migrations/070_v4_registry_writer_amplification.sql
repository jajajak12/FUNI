-- Public registry lookups are case-folded and use the expression indexes
-- added by migration 018. The original case-sensitive address indexes are
-- redundant and made every canonical pool insert maintain two extra trees.
DROP INDEX IF EXISTS idx_v4_registry_currency0;
DROP INDEX IF EXISTS idx_v4_registry_currency1;
