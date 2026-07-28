-- ROBINHOOD_GMGN_SOURCE_COVERAGE_AND_REALERT_DEDUP_FIXED
-- Natural-alert dedup now uses (token_address, natural_key) so worker
-- restarts do not reset it and metric churn cannot generate new identities.
-- The old snapshot-hash PK remains as a secondary column for back-compat
-- reads (delivery rows still reference it).
CREATE TABLE IF NOT EXISTS gmgn_robinhood_alert_dedupe_v2 (
  token_address TEXT NOT NULL COLLATE NOCASE,
  natural_key TEXT NOT NULL,
  last_alerted_at_ms INTEGER NOT NULL,
  last_alerted_market_cap_usd REAL,
  last_alerted_liquidity_usd REAL,
  last_alerted_volume_1h_usd REAL,
  last_alerted_total_fee_eth REAL,
  last_alerted_holder_count INTEGER,
  PRIMARY KEY(token_address, natural_key)
);

-- Backfill: copy any prior rows (none expected, but defensive) using the
-- snapshot hash as the natural_key so the new PK does not collide.
INSERT OR IGNORE INTO gmgn_robinhood_alert_dedupe_v2(
  token_address, natural_key, last_alerted_at_ms,
  last_alerted_market_cap_usd, last_alerted_liquidity_usd,
  last_alerted_volume_1h_usd, last_alerted_total_fee_eth,
  last_alerted_holder_count
)
SELECT
  token_address,
  'legacy:' || admission_snapshot_hash AS natural_key,
  alerted_at_ms,
  NULL, NULL, NULL, NULL, NULL
FROM gmgn_robinhood_alert_dedupe
WHERE NOT EXISTS (
  SELECT 1 FROM gmgn_robinhood_alert_dedupe_v2 v
  WHERE v.token_address = gmgn_robinhood_alert_dedupe.token_address
);

DROP TABLE IF EXISTS gmgn_robinhood_alert_dedupe;
ALTER TABLE gmgn_robinhood_alert_dedupe_v2 RENAME TO gmgn_robinhood_alert_dedupe;

CREATE INDEX IF NOT EXISTS idx_gmgn_robinhood_alert_dedupe_token
  ON gmgn_robinhood_alert_dedupe(token_address);
